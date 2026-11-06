import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import { createKernel } from '../src/windows/kernel.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import { scratch } from './support.ts';

const path = resolve('src/dispatcher/daemon.ts');
const daemon: Record<string, any> = fs.existsSync(path) ? await import(pathToFileURL(path).href) : {};

function processApi(created: bigint, image: string) {
  const terminated: bigint[] = [], closed: bigint[] = [];
  const api = {
    GetLastError: () => 0, OpenProcess: () => 40n,
    GetProcessTimes: (_handle: bigint, buffer: Buffer) => { buffer.writeBigUInt64LE(created); return 1; },
    QueryFullProcessImageNameW: (_handle: bigint, _flags: number, buffer: Buffer, length: number[]) => {
      buffer.write(image, 'utf16le'); length[0] = image.length; return 1;
    },
    CloseHandle: (handle: bigint) => { closed.push(handle); return 1; },
    WaitForSingleObject: (_handle: bigint, ms: number) => ms ? 0 : 258,
    TerminateProcess: (handle: bigint) => { terminated.push(handle); return 1; },
  };
  return { api, terminated, closed };
}

test('termination checks exact FILETIME and image on its still-open owned process handle', () => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT); scratch('phase7b-native-identity-');
  const fixture = processApi(133434343434343434n, 'C:\\synthetic\\node.exe');
  using kernel = createKernel(fixture.api);
  const identity = { pid: 87654, created: '133434343434343434', image: 'C:\\synthetic\\node.exe' };
  expect((kernel as any).terminate).toBeTypeOf('function');
  if (!(kernel as any).terminate) return;
  expect((kernel as any).terminate({ ...identity, created: '133434343434343433' })).toBe(false);
  expect((kernel as any).terminate({ ...identity, image: 'C:\\other\\node.exe' })).toBe(false);
  expect(fixture.terminated).toEqual([]);
  expect((kernel as any).terminate(identity)).toBe(true);
  expect(fixture.terminated).toEqual([40n]);
  expect(fixture.closed).toEqual([40n, 40n, 40n]);
  expect(kernel.resources.size).toBe(0);
});

test('native launch captures FILETIME from the CreateProcess-owned handle before closing it', () => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT); scratch('phase7b-launch-identity-');
  const f = processApi(133434343434343434n, 'C:\\synthetic\\node.exe');
  const api = { ...f.api, GetCurrentProcess: () => -1n,
    IsProcessInJob: (_process: bigint, _job: unknown, answer: number[]) => { answer[0] = 1; return 1; },
    CreateProcessW: (_application: string, _command: Buffer, _ps: unknown, _ts: unknown, inherited: number, flags: number, _env: Buffer, _cwd: string, _startup: unknown, result: any) => {
      expect(inherited).toBe(0); expect(flags).toBe(0x08000600);
      Object.assign(result, { process: 40n, thread: 41n, pid: 87654, tid: 87655 }); return 1;
    },
  };
  using kernel = createKernel(api);
  expect((kernel as any).launchIdentity).toBeTypeOf('function');
  if (!(kernel as any).launchIdentity) return;
  const identity = (kernel as any).launchIdentity({ executable: 'C:\\synthetic\\node.exe', args: ['C:\\synthetic\\cli.js'], cwd: 'C:\\synthetic', environment: {}, breakaway: false });
  expect(identity).toEqual({ pid: 87654, created: '133434343434343434', image: 'C:\\synthetic\\node.exe' });
  expect(f.closed).toEqual([41n, 40n]); expect(kernel.resources.size).toBe(0);
});

test('already exited process needs no image query for running/wait/termination checks', () => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT); scratch('phase7b-exited-identity-');
  const f = processApi(133434343434343434n, 'C:\\synthetic\\node.exe');
  const image = vi.fn(() => 0);
  using kernel = createKernel({ ...f.api, GetLastError: () => 5, QueryFullProcessImageNameW: image, WaitForSingleObject: () => 0 });
  const identity = { pid: 87654, created: '133434343434343434', image: 'C:\\synthetic\\node.exe' };
  expect(() => kernel.running(identity)).not.toThrow();
  expect(kernel.running(identity)).toBe(false);
  expect(kernel.wait(identity, 1)).toBe(true);
  expect(kernel.terminate(identity)).toBe(false);
  expect(image).not.toHaveBeenCalled(); expect(f.terminated).toEqual([]); expect(kernel.resources.size).toBe(0);
});

test('canonical DB named pipe excludes aliases and releases only with the owning lifecycle', async () => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const f = scratch('phase7b-pipe-');
  const target = join(f.root, 'store'); fs.mkdirSync(target);
  const alias = join(f.root, 'alias'); fs.symlinkSync(target, alias, 'junction');
  expect(daemon.canonicalDb).toBeTypeOf('function'); expect(daemon.acquireInstance).toBeTypeOf('function');
  if (!daemon.canonicalDb || !daemon.acquireInstance) return;
  const one = daemon.canonicalDb(join(target, 'fixture.db'));
  const two = daemon.canonicalDb(join(alias, 'fixture.db'));
  expect(one.toLowerCase()).toBe(two.toLowerCase());
  const pipe = await daemon.acquireInstance(one);
  try { await expect(daemon.acquireInstance(two)).rejects.toThrow('daemon.already-running'); }
  finally { await pipe.close(); }
  const next = await daemon.acquireInstance(two); await next.close();
  expect(fs.existsSync(one)).toBe(false);
});

test('help and stop without a receipt cannot open a synthetic DB or resolve its cutoff', async () => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const f = scratch('phase7b-stop-no-db-');
  expect(daemon.stopDaemon).toBeTypeOf('function');
  if (!daemon.stopDaemon) return;
  const open = vi.spyOn(fs, 'openSync');
  try {
    const result = await daemon.stopDaemon({ db: { path: f.path }, _config_path: f.config });
    expect(result).toMatchObject({ stopped: true, running: false });
    expect(open.mock.calls.some(([path]) => String(path) === f.path)).toBe(false);
    expect(fs.existsSync(f.path)).toBe(false);
  } finally { open.mockRestore(); }
});
