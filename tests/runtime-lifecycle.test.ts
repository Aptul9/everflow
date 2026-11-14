import { fork, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import { isolatedEnvironment } from '../scripts/build.ts';
import { loadConfig } from '../src/core/config.ts';
import { openDb, prepareStart } from '../src/core/db.ts';
import { enqueue, complete } from '../src/core/jobs.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import { createKernel, sameProcess, spawnedIdentity } from '../src/windows/kernel.ts';
import type { ProcessIdentity } from '../src/windows/kernel.ts';
import { runSource } from '../src/watchers/source.ts';
import { scratch } from './support.ts';
import { bounded } from '../src/core/daemon.ts';

const module = resolve('src/core/runtime.ts');
const runtime: Record<string, any> = existsSync(module) ? await import(pathToFileURL(module).href) : {};

function verifyCleanupTarget(packet: { identity: ProcessIdentity; owner: ProcessIdentity }, expectedOwner: ProcessIdentity,
  childOf: (identity: ProcessIdentity, owner: ProcessIdentity) => boolean, accept: (identity: ProcessIdentity) => void) {
  expect(sameProcess(packet.owner, expectedOwner), 'Unverifiable child owner identity').toBe(true);
  expect(childOf(packet.identity, packet.owner), 'Unverifiable child parent identity').toBe(true);
  accept(packet.identity);
}

test.each(['owner-mismatch', 'parent-false', 'parent-throws'])('cleanup target rejected ownership never reaches candidate termination (%s)', (mode) => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT); const f = scratch('phase7b-cleanup-target-');
  const owner = { pid: 1000000001, created: '134384000000000001', image: 'C:\\synthetic\\watcher.exe' };
  const candidate = { pid: 1000000002, created: '134384000000000002', image: 'C:\\candidate\\node.exe' };
  const packet = { identity: candidate, owner: mode === 'owner-mismatch' ? { ...owner, created: '134384000000000099' } : owner };
  const childOf = vi.fn(() => { if (mode === 'parent-throws') throw new Error('synthetic validation failure'); return mode !== 'parent-false'; });
  const terminate = vi.fn(); let target: ProcessIdentity | undefined;
  try { verifyCleanupTarget(packet, owner, childOf, (identity) => { target = identity; }); } catch { /* Rejected ownership is the injected case. */ }
  finally { if (target) terminate(target); }
  writeFileSync(join(f.root, 'proof.json'), JSON.stringify({ config: f.config, artifact: process.env.TEST_BUILD_RECEIPT, mode, accepted: target ?? null, parentChecks: childOf.mock.calls.length, terminated: terminate.mock.calls }, null, 2));
  expect(target).toBeUndefined(); expect(terminate).not.toHaveBeenCalled();
  if (mode === 'owner-mismatch') expect(childOf).not.toHaveBeenCalled();
});

test('cleanup target successful exact owner and parent checks permit only the verified identity', () => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT); scratch('phase7b-cleanup-target-');
  const owner = { pid: 1000000001, created: '134384000000000001', image: 'C:\\synthetic\\watcher.exe' };
  const candidate = { pid: 1000000002, created: '134384000000000002', image: 'C:\\synthetic\\ssh.exe' };
  const terminate = vi.fn(), childOf = vi.fn(() => true); let target: ProcessIdentity | undefined;
  try { verifyCleanupTarget({ identity: candidate, owner }, owner, childOf, (identity) => { target = identity; }); }
  finally { if (target) terminate(target); }
  expect(childOf).toHaveBeenCalledWith(candidate, owner); expect(terminate).toHaveBeenCalledExactlyOnceWith(candidate);
});

test('source lifecycle accepts only the owned stop IPC message and removes its listeners', async () => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  scratch('phase7b-ipc-');
  const controller = new AbortController();
  const before = process.listenerCount('message');
  let closed = false;
  const ready = Promise.withResolvers<void>();
  const pending = runSource('teams', { once: false, poll: 30 }, () => { ready.resolve(); }, {
    wait: (ms, signal) => delay(ms, undefined, { signal }), close: () => { closed = true; },
  }, controller.signal);
  try {
    await ready.promise;
    process.emit('message', { type: 'unrelated.stop' }, undefined);
    expect(closed).toBe(false);
    process.emit('message', { type: 'everflow.stop' }, undefined);
    await Promise.race([pending, delay(100).then(() => undefined)]);
    expect(closed).toBe(true);
  } finally { controller.abort(); await pending; }
  expect(process.listenerCount('message')).toBe(before);
});

test('relay owner disconnect aborts and observes its actual synthetic SSH child before watcher exit', async () => {
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const f = scratch('phase7b-ssh-cleanup-');
  const script = join(f.root, 'synthetic-relay.mjs');
  const relay = pathToFileURL(join(artifact.root, 'dist/watchers/relay.js')).href;
  const source = pathToFileURL(join(artifact.root, 'dist/watchers/source.js')).href;
  writeFileSync(script, `import {spawn} from 'node:child_process';
    import {getEventListeners} from 'node:events';
    import {sshQuery} from ${JSON.stringify(relay)};
    import {runSource} from ${JSON.stringify(source)};
    let target;const fallback=new AbortController();process.on('message',value=>{if(value?.type==='fixture.cleanup')fallback.abort();});
    const code=await runSource('teamsrelay',{once:false,poll:30},async(signal)=>{
      try { await sshQuery({host:'synthetic.invalid',root:'/synthetic',owner:'me@example.invalid'},'/synthetic/a.db','SELECT 1',signal,
        (_command,_args,options)=>{target=spawn(process.execPath,['-e','setTimeout(()=>process.stdout.end("[]"),30000)'],options);process.send({type:'fixture.ssh',pid:target.pid});return target;}); }
      finally {process.stdout.write(JSON.stringify({closed:target?.exitCode!==null||target?.signalCode!==null,
        abortListeners:getEventListeners(signal,'abort').length,timers:process.getActiveResourcesInfo().filter(value=>value==='Timeout').length,
        errorListeners:target?.listenerCount('error'),closeListeners:target?.listenerCount('close'),
        stdoutListeners:target?.stdout.listenerCount('data'),stderrListeners:target?.stderr.listenerCount('data')})+'\\n');}
    },{},fallback.signal);process.exitCode=code;if(process.connected)process.disconnect();`);
  const child = fork(script, [], { cwd: artifact.root, env: { ...isolatedEnvironment(artifact.root, process.env), EVERFLOW_SOURCE_OWNER: String(process.pid) }, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  using kernel = createKernel();
  const watcherIdentity = spawnedIdentity(child, (pid) => kernel.processIdentity(pid));
  let output = '', stderr = '';
  child.stdout!.on('data', (part: Buffer) => { output += part.toString(); });
  child.stderr!.on('data', (part: Buffer) => { stderr += part.toString(); });
  const messages: any[] = [];
  child.on('message', (value) => messages.push(value));
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => { child.off('error', reject); resolve(); }); });
  const exit = Promise.all([exited, finished(child.stdout!, { cleanup: true }), finished(child.stderr!, { cleanup: true })]).then(() => {});
  let target: ReturnType<ReturnType<typeof createKernel>['processIdentity']> | undefined;
  let candidate: ProcessIdentity | undefined, teardown: Record<string, unknown> | undefined;
  try {
    const pid = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Synthetic SSH did not start')), 5000);
      child.on('message', (value: any) => { if (value.type === 'fixture.ssh') { clearTimeout(timeout); resolve(value.pid); } });
    });
    const packet = await bounded(new Promise<any>((resolve) => {
      const existing = messages.find((value) => value.type === 'everflow.child' && value.pid === pid && value.active === true);
      if (existing) { resolve(existing); return; }
      const received = (value: any) => { if (value.type === 'everflow.child' && value.pid === pid && value.active === true) { child.off('message', received); resolve(value); } };
      child.on('message', received);
    }), 5000, 'fixture.child-registration');
    candidate = packet.identity;
    verifyCleanupTarget(packet, await watcherIdentity, (identity, owner) => kernel.childOf(identity, owner), (identity) => { target = identity; });
    child.disconnect();
    await Promise.race([exit, delay(5000).then(() => { throw new Error('Owned relay failed disconnect shutdown'); })]);
    expect(child.exitCode, stderr).toBe(0);
    expect(output).toContain('"closed":true');
    teardown = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
    expect(teardown).toEqual({ closed: true, abortListeners: 0, timers: 0, errorListeners: 0, closeListeners: 0, stdoutListeners: 0, stderrListeners: 0 });
    expect((kernel as any).running?.(target)).toBe(false);
  } finally {
    if (child.connected) child.send({ type: 'fixture.cleanup' });
    await Promise.race([exit, delay(5000).then(() => { child.kill(); })]);
    if (target) (kernel as any).terminate?.(target);
    await exit;
    writeFileSync(join(f.root, 'proof.json'), JSON.stringify({ config: f.config, artifact: process.env.TEST_BUILD_RECEIPT,
      candidate: candidate ?? null, fallbackTarget: target ?? null, unverifiableChild: Boolean(candidate && !target),
      watcherClosed: (child.exitCode !== null || child.signalCode !== null) && child.stdout!.readableEnded && child.stderr!.readableEnded,
      watcherExitCode: child.exitCode, stdoutEnded: child.stdout!.readableEnded, stderrEnded: child.stderr!.readableEnded,
      sshRunning: target ? kernel.running(target) : null, teardown }, null, 2));
  }
});

test('runtime renews awaited work, stops local requests and leaves admitted remote turns intact', async () => {
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const f = scratch('phase7b-runner-');
  const cfg = loadConfig(f.config);
  cfg.tickets.enabled = true;
  cfg.jobs.lease_seconds = 4; cfg.jobs.renew_seconds = 1;
  using db = openDb(f.path);
  prepareStart(db);
  const ticket = Number(db.prepare("INSERT INTO ticket(title,lifecycle,approved_at,session_id,created_at) VALUES ('Synthetic','active',?,'synthetic-session',?)")
    .run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
  db.prepare("INSERT INTO turn(ticket,kind,prompt_id,text,session_id,state,created_at) VALUES (?,'forward','synthetic-prompt','Immutable','synthetic-session','admitted',?)")
    .run(ticket, new Date().toISOString());
  const id = enqueue(db, 'collect', 'synthetic-collect', { turn: 1 }, ticket);
  expect(runtime.startRuntime).toBeTypeOf('function');
  if (!runtime.startRuntime) return;
  const entered = Promise.withResolvers<void>();
  let localAborted = false;
  const instance = await runtime.startRuntime(cfg, db, { buildReceipt: process.env.TEST_BUILD_RECEIPT, runId: 'synthetic-run',
    handlers: { collect: async (_cfg: unknown, _db: unknown, _job: unknown, options: any) => {
      entered.resolve();
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => { localAborted = true; resolve(); }, { once: true }));
    } },
  });
  try {
    await entered.promise;
    const initial = String(db.prepare('SELECT lease_until FROM job WHERE id=?').get(id)!.lease_until);
    await delay(1250);
    expect(String(db.prepare('SELECT lease_until FROM job WHERE id=?').get(id)!.lease_until) > initial).toBe(true);
    await instance.close();
    expect(localAborted).toBe(true);
    expect(db.prepare('SELECT state FROM turn').get()?.state).toBe('admitted');
    expect(db.isTransaction).toBe(false);
  } finally { await instance.close(); }
  expect(artifact.root).toBeTruthy();
});

test('runtime reclaims only expired leases and reconciles old turn identities before admitting new input', async () => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const f = scratch('phase7b-reconcile-'); const cfg = loadConfig(f.config);
  cfg.tickets.enabled = cfg.chats.enabled = true;
  cfg.jobs.collect_seconds = 1;
  using db = openDb(f.path); prepareStart(db);
  const at = new Date().toISOString();
  const first = Number(db.prepare("INSERT INTO ticket(title,lifecycle,approved_at,session_id,created_at) VALUES ('Old','active',?,'old-session',?)").run(at, at).lastInsertRowid);
  const second = Number(db.prepare("INSERT INTO ticket(title,lifecycle,approved_at,created_at) VALUES ('New','active',?,?)").run(at, at).lastInsertRowid);
  const turn = Number(db.prepare("INSERT INTO turn(ticket,kind,prompt_id,text,session_id,state,created_at) VALUES (?,'forward','old-prompt','Immutable','old-session','admitted',?)").run(first, at).lastInsertRowid);
  const old = enqueue(db, 'collect', 'old-collect', { turn }, first);
  const fresh = enqueue(db, 'start_chat', 'new-input', {}, second);
  db.prepare("UPDATE job SET state='running',run_id='dead-run',lease_token='old-token',lease_until=? WHERE id=?").run(new Date(Date.now() + 1000).toISOString(), old);
  expect(runtime.startRuntime).toBeTypeOf('function');
  if (!runtime.startRuntime) return;
  const calls: number[] = [];
  const handled = (_cfg: unknown, connection: ReturnType<typeof openDb>, job: any) => {
    calls.push(job.id); complete(connection, job, () => {});
  };
  const instance = await runtime.startRuntime(cfg, db, { buildReceipt: process.env.TEST_BUILD_RECEIPT, runId: 'new-run',
    handlers: { collect: handled, start_chat: handled, sync: handled, archive: handled, purge: handled },
  });
  try {
    expect(db.prepare('SELECT run_id,state FROM job WHERE id=?').get(old)).toMatchObject({ run_id: 'dead-run', state: 'running' });
    expect(calls).not.toContain(fresh);
    await delay(2200);
    expect(calls.indexOf(old)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(fresh)).toBeGreaterThan(calls.indexOf(old));
  } finally { await instance.close(); }
});
