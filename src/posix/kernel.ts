import { spawn } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { NativeError, NativeResources } from '../windows/kernel.ts';
import type { LaunchOptions, ProcessIdentity, ProcessRow } from '../windows/kernel.ts';

// Linux counterpart of the Windows kernel bridge, for the methods the daemon, runtime and watchers use.
// Identity = pid + start time in clock ticks since boot (/proc/<pid>/stat field 22) + executable (/proc/<pid>/exe).
// The Teams handle and file-mapping methods stay Windows-only.

type Stat = { state: string; parent: number; started: string };

function stat(pid: number): Stat | null {
  let text: string;
  try { text = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw new NativeError('native.process-open'); }
  // comm (field 2) may hold spaces and parentheses: the fields after it start past the last ')'
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  const state = fields[0], parent = Number(fields[1]), started = fields[19];
  if (!state || !Number.isSafeInteger(parent) || !started || !/^\d+$/.test(started)) throw new NativeError('native.process-times');
  return { state, parent, started };
}

function image(pid: number): string | null {
  try { return readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new NativeError('native.process-image'); }
}

function checkPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x3fffffff) throw new NativeError('native.invalid-pid');
}

const pause = new Int32Array(new SharedArrayBuffer(4));
const unsupported = (): never => { throw new NativeError('native.windows-x64-required'); };

export function createPosixKernel() {
  const resources = new NativeResources(() => true);
  // The live stat of the exact process, or null when it is gone, reused or a zombie (exited, not yet reaped).
  function live(identity: ProcessIdentity): Stat | null {
    checkPid(identity.pid);
    if (!/^\d+$/.test(identity.created) || !isAbsolute(identity.image)) throw new NativeError('native.invalid-process-identity');
    const current = stat(identity.pid);
    if (!current || current.state === 'Z' || current.started !== identity.created || image(identity.pid) !== identity.image) return null;
    return current;
  }
  function processIdentity(pid: number): ProcessIdentity {
    checkPid(pid);
    const current = stat(pid);
    if (!current) throw new NativeError('native.process-open');
    // A child that already exited and is not reaped keeps its pid and start time but loses /proc/<pid>/exe. That literal path
    // never equals a live image, so the identity can only ever read as exited, as Windows reports for an exited handle.
    const path = current.state === 'Z' ? `/proc/${pid}/exe` : image(pid);
    if (!path) throw new NativeError('native.process-open');
    return { pid, created: current.started, image: path };
  }
  function wait(identity: ProcessIdentity, milliseconds: number): boolean {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 120000) throw new NativeError('native.wait-limit');
    const deadline = Date.now() + milliseconds;
    for (;;) {
      if (!live(identity)) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      Atomics.wait(pause, 0, 0, Math.min(left, 25));
    }
  }
  function launch(options: LaunchOptions): ProcessIdentity {
    if (!isAbsolute(options.executable) || !isAbsolute(options.cwd) || /\0/.test(options.executable + options.cwd)) throw new NativeError('native.invalid-argument');
    const child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.environment as NodeJS.ProcessEnv, detached: true, stdio: 'ignore', shell: false });
    // spawn returns once exec has succeeded, so /proc already shows the new image
    if (!child.pid) throw new NativeError('native.create-process');
    child.unref();
    return processIdentity(child.pid);
  }
  return {
    resources,
    processes(): ProcessRow[] { return unsupported(); },
    inJob: () => false,
    processIdentity,
    launch(options: LaunchOptions): number { return launch(options).pid; },
    launchIdentity: launch,
    running: (identity: ProcessIdentity) => live(identity) !== null,
    childOf(identity: ProcessIdentity, parent: ProcessIdentity): boolean {
      const current = live(identity);
      return current !== null && current.parent === parent.pid && live(parent) !== null;
    },
    wait,
    terminate(identity: ProcessIdentity): boolean {
      if (identity.pid === process.pid) throw new NativeError('native.self-termination');
      if (!live(identity)) return false;
      try { process.kill(identity.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw new NativeError('native.process-terminate'); }
      if (!wait(identity, 5000)) throw new NativeError('native.process-exit-timeout');
      return true;
    },
    shared: unsupported, present: unsupported, liveHandles: unsupported, validate: unsupported, identity: unsupported,
    currentIdentity: unsupported, mapped: unsupported,
    close(_handle: bigint): void { unsupported(); },
    [Symbol.dispose]() { resources.dispose(); },
  };
}
