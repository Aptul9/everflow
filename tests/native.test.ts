import fs from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { createKernel, NativeResources, parseHandleInventory, quoteWindowsArgument, teamsDescendants, win32Ffi } from '../src/windows/kernel.ts';
import type { NativeBindings } from '../src/windows/kernel.ts';
import { createComSession } from '../src/windows/com.ts';
import { createDpapi } from '../src/windows/dpapi.ts';
import { cookieSnapshotRows, sameCapture, snapshotCookies } from '../src/windows/snapshot.ts';
import type { SnapshotFiles } from '../src/windows/snapshot.ts';
import { scratch } from './support.ts';

test('native registry refuses unowned and duplicate releases, closes remaining resources after an error', () => {
  const closed: string[] = [];
  const resources = new NativeResources((kind, pointer) => { closed.push(`${kind}:${pointer}`); return pointer !== 3n; });
  resources.own(2n, 'handle');
  resources.own(3n, 'view');
  expect(() => resources.own(2n, 'handle')).toThrow(/native.duplicate-owner/);
  expect(() => resources.close(88n, 'handle')).toThrow(/native.unowned/);
  expect(() => resources.dispose()).toThrow(/native.cleanup/);
  expect(closed).toEqual(['view:3', 'handle:2']);
  expect(resources.size).toBe(1);
});

test.each([
  ['', '""'], ['plain', 'plain'], ['two words', '"two words"'], ['x"y', '"x\\"y"'], ['a b\\', '"a b\\\\"'],
])('Windows command argument %j is quoted without losing characters', (input, expected) => {
  expect(quoteWindowsArgument(input)).toBe(expected);
});

test('Teams handle candidates include only Teams and its WebView descendants', () => {
  expect(teamsDescendants([
    { pid: 1, parent: 0, exe: 'ms-teams.exe' }, { pid: 2, parent: 1, exe: 'msedgewebview2.exe' },
    { pid: 3, parent: 2, exe: 'MSEDGEWEBVIEW2.EXE' }, { pid: 4, parent: 1, exe: 'other.exe' },
    { pid: 5, parent: 4, exe: 'msedgewebview2.exe' }, { pid: 6, parent: 0, exe: 'msedgewebview2.exe' },
  ])).toEqual([1, 2, 3]);
});

function kernelBindings() {
  return {
    GetLastError: () => 5, GetCurrentProcess: () => -1n,
    IsProcessInJob: vi.fn((_p, _j, out) => { out[0] = 0; return 1; }),
    CreateProcessW: vi.fn((_app, _cmd, _ps, _ts, _inherit, _flags, _env, _cwd, _si, out) => {
      Object.assign(out, { process: 21n, thread: 22n, pid: 1234, tid: 99 }); return 1;
    }),
    CloseHandle: vi.fn(() => 1), UnmapViewOfFile: vi.fn(() => 1),
  } satisfies NativeBindings;
}

test('native launch uses the proven flags, mutable UTF16 argv, explicit environment and no inherited handles', () => {
  const bindings = kernelBindings();
  using native = createKernel(bindings);
  const pid = native.launch({ executable: 'C:/synthetic/node.exe', args: ['', 'a b', 'x"y'], cwd: 'C:/synthetic', environment: { TEST: 'synthetic' } });
  expect(pid).toBe(1234);
  const args = bindings.CreateProcessW.mock.calls[0]!;
  expect(args[0]).toBe('C:/synthetic/node.exe');
  expect(args[1].toString('utf16le')).toBe('C:/synthetic/node.exe "" "a b" "x\\"y"\0');
  expect(args[4]).toBe(0);
  expect(args[5]).toBe(0x09000600);
  expect(args[6].toString('utf16le')).toBe('TEST=synthetic\0\0');
  expect(args[8].cb).toBe(104);
  expect(bindings.CloseHandle.mock.calls).toEqual([[22n], [21n]]);
  expect(native.resources.size).toBe(0);
});

test('native launch refuses to break away from an unrelated outer job', () => {
  const bindings = kernelBindings();
  bindings.IsProcessInJob.mockImplementation((_p, _j, out) => { out[0] = 1; return 1; });
  using native = createKernel(bindings);
  expect(() => native.launch({ executable: 'C:/synthetic/node.exe', args: [], cwd: 'C:/synthetic', environment: {} })).toThrow(/native.outer-job/);
  expect(bindings.CreateProcessW).not.toHaveBeenCalled();
});

test('explicit contained launch keeps an unrelated outer job and omits breakaway', () => {
  const bindings = kernelBindings();
  bindings.IsProcessInJob.mockImplementation((_p, _j, out) => { out[0] = 1; return 1; });
  using native = createKernel(bindings);
  const options = { executable: 'C:/synthetic/node.exe', args: [] as string[], cwd: 'C:/synthetic', environment: {}, breakaway: false };
  expect(native.launch(options)).toBe(1234);
  expect(bindings.CreateProcessW.mock.calls[0]![5]).toBe(0x08000600);
});

test('failed CreateProcessW never registers or closes unowned source handles', () => {
  const bindings = kernelBindings();
  bindings.CreateProcessW.mockImplementation(() => 0);
  using native = createKernel(bindings);
  expect(() => native.launch({ executable: 'C:/synthetic/node.exe', args: [], cwd: 'C:/synthetic', environment: {} })).toThrow(/native.create-process/);
  expect(bindings.CloseHandle).not.toHaveBeenCalled();
});

test('x64 handle inventory rejects oversized counts and preserves pointer-width IDs', () => {
  const bytes = Buffer.alloc(56);
  bytes.writeBigUInt64LE(1n, 0);
  bytes.writeBigUInt64LE(42n, 24);
  bytes.writeBigUInt64LE(0x123456789n, 32);
  bytes.writeUInt32LE(0x81, 40);
  expect(parseHandleInventory(bytes, bytes.length)).toEqual([{ pid: 42, handle: 0x123456789n, access: 0x81 }]);
  bytes.writeBigUInt64LE(2n, 0);
  expect(() => parseHandleInventory(bytes, bytes.length)).toThrow(/native.handle-inventory/);
  expect(() => parseHandleInventory(Buffer.alloc(8), 8)).toThrow(/native.handle-inventory/);
});

test('mapping size bound is enforced before any view allocation', () => {
  const bindings: NativeBindings = { ...kernelBindings(),
    CreateFileW: () => 1n,
    GetFileSizeEx: (_h, out) => { out[0] = 64 * 1024 * 1024 + 1; return 1; },
    CreateFileMappingW: vi.fn(),
  };
  using native = createKernel(bindings);
  const { handle } = native.shared('C:/synthetic/Cookies');
  try { expect(() => native.mapped(handle!)).toThrow(/native.mapping-size/); }
  finally { native.close(handle!); }
  expect(bindings.CreateFileMappingW).not.toHaveBeenCalled();
});

test.each([NaN, -1, 64 * 1024 * 1024 + 1, 0.5])('invalid caller mapping limit %s is rejected even for an empty file', (limit) => {
  const bindings: NativeBindings = { ...kernelBindings(), CreateFileW: () => 1n,
    GetFileSizeEx: (_h, out) => { out[0] = 0; return 1; }, CreateFileMappingW: vi.fn() };
  using native = createKernel(bindings);
  const { handle } = native.shared('C:/synthetic/empty');
  try { expect(() => native.mapped(handle!, limit)).toThrow(/native.mapping-size/); }
  finally { native.close(handle!); }
  expect(bindings.CreateFileMappingW).not.toHaveBeenCalled();
});

test('locked inventory is capped at128MiB before another allocation', () => {
  const bindings: NativeBindings = { ...kernelBindings(),
    CreateToolhelp32Snapshot: () => 1n,
    Process32FirstW: (_h, entry: Buffer) => { entry.writeUInt32LE(42, 8); entry.write('ms-teams.exe\0', 44, 'utf16le'); return 1; },
    Process32NextW: () => 0,
    GetLastError: () => 18,
    NtQuerySystemInformation: vi.fn((_c, _b, _l, needed) => { needed[0] = 128 * 1024 * 1024 + 1; return 0xc0000004; }),
  };
  using native = createKernel(bindings);
  expect(() => native.liveHandles(['C:/synthetic/Cookies'])).toThrow(/native.handle-inventory-limit/);
  expect(bindings.NtQuerySystemInformation).toHaveBeenCalledOnce();
});

test('locked fallback duplicates read-data+attributes only, never closes the source handle', () => {
  const closed: bigint[] = [];
  const bindings: NativeBindings = { ...kernelBindings(),
    CloseHandle: (handle) => { closed.push(handle); return 1; },
    CreateToolhelp32Snapshot: () => 1n,
    Process32FirstW: (_h, entry: Buffer) => { entry.writeUInt32LE(42, 8); entry.write('ms-teams.exe\0', 44, 'utf16le'); return 1; },
    Process32NextW: () => 0, GetLastError: () => 18,
    NtQuerySystemInformation: (_c, bytes: Buffer, _l, needed) => {
      needed[0] = 56; bytes.writeBigUInt64LE(1n, 0); bytes.writeBigUInt64LE(42n, 24); bytes.writeBigUInt64LE(0x123456789n, 32); bytes.writeUInt32LE(0x81, 40); return 0;
    },
    OpenProcess: vi.fn(() => 2n),
    DuplicateHandle: vi.fn((_p, _source, _target, out, _access, _inherit, _options) => { out[0] = 3n; return 1; }),
    GetFileType: () => 1,
    GetFinalPathNameByHandleW: (_h, name: Buffer) => { const value = '\\\\?\\C:\\synthetic\\Cookies'; name.write(value, 'utf16le'); return value.length; },
    GetFileSizeEx: (_h, out) => { out[0] = 64; return 1; },
  };
  using native = createKernel(bindings);
  const found = native.liveHandles(['C:/synthetic/Cookies']);
  expect(found.get('C:/synthetic/Cookies')).toBe(3n);
  expect(bindings.OpenProcess).toHaveBeenCalledWith(0x40, 0, 42);
  expect((bindings.DuplicateHandle as ReturnType<typeof vi.fn>).mock.calls[0]!.slice(4)).toEqual([0x81, 0, 0]);
  native.close(3n);
  expect(closed.sort()).toEqual([1n, 2n, 3n]);
  expect(closed).not.toContain(0x123456789n);
});

function comBindings(hr = 0) {
  return {
    initialize: vi.fn(() => 1), uninitialize: vi.fn(),
    active: vi.fn(() => ({ hresult: hr, pointer: hr < 0 ? null : 10n })),
    queryDispatch: vi.fn(() => ({ hresult: 0, pointer: 11n })),
    releasePointer: vi.fn(), wrapDispatch: vi.fn((_pointer: bigint) => ({ fixture: true })),
    releaseObject: vi.fn(), points: vi.fn(() => []), pump: vi.fn(),
  };
}

test('COM attach missing returns MK_E_UNAVAILABLE without an activation path and balances S_FALSE initialization', () => {
  const bindings = comBindings(-2147221021);
  using session = createComSession(bindings);
  expect(session.attachOutlook()).toEqual({ object: null, hresult: '0x800401e3' });
  session.close();
  expect(bindings.initialize).toHaveBeenCalledOnce();
  expect(bindings.uninitialize).toHaveBeenCalledOnce();
  expect(bindings.queryDispatch).not.toHaveBeenCalled();
  expect(bindings.wrapDispatch).not.toHaveBeenCalled();
});

test('COM transfers only IDispatch ownership into winax and releases IUnknown exactly once', () => {
  const bindings = comBindings();
  using session = createComSession(bindings);
  const attached = session.attachOutlook();
  expect(attached.object).toEqual({ fixture: true });
  expect(bindings.releasePointer.mock.calls).toEqual([[10n]]);
  session.close();
  expect(bindings.releaseObject).toHaveBeenCalledWith(attached.object);
  expect(bindings.releaseObject).toHaveBeenCalledOnce();
  expect(bindings.uninitialize).toHaveBeenCalledOnce();
});

test('COM QueryInterface failure still releases IUnknown and closes apartment', () => {
  const bindings = comBindings();
  bindings.queryDispatch.mockReturnValue({ hresult: -2147467262, pointer: null as unknown as bigint });
  using session = createComSession(bindings);
  expect(() => session.attachOutlook()).toThrow(/com.query-interface/);
  session.close();
  expect(bindings.releasePointer.mock.calls).toEqual([[10n]]);
  expect(bindings.uninitialize).toHaveBeenCalledOnce();
});

test('COM wrapper failure releases both owned native references', () => {
  const bindings = comBindings();
  bindings.wrapDispatch.mockImplementation(() => { throw new Error('synthetic wrapper failure'); });
  using session = createComSession(bindings);
  expect(() => session.attachOutlook()).toThrow(/com.wrap-dispatch/);
  session.close();
  expect(bindings.releasePointer.mock.calls).toEqual([[11n], [10n]]);
});

test('a null COM wrapper cannot consume the owned dispatch reference', () => {
  const bindings = comBindings();
  bindings.wrapDispatch.mockReturnValue(null as never);
  using session = createComSession(bindings);
  expect(() => session.attachOutlook()).toThrow(/com.wrap-dispatch/);
  session.close();
  expect(bindings.releasePointer.mock.calls).toEqual([[11n], [10n]]);
});

test('failed COM initialization does not uninitialize an unowned apartment', () => {
  const bindings = comBindings();
  bindings.initialize.mockReturnValue(-2147417850);
  expect(() => createComSession(bindings)).toThrow(/com.initialize/);
  expect(bindings.uninitialize).not.toHaveBeenCalled();
});

test('optional COM NewMailEx connection point is unadvised before releasing attached objects', () => {
  const order: string[] = [];
  const listener = vi.fn();
  let pointReferences = 0, dispatchReferences = 0, remainingAtUninitialize = -1;
  let sink: { NewMailEx(ids: string): void } | undefined;
  const point = { getMethods: () => ['NewMailEx'], advise: vi.fn((value) => { sink = value; return 7; }), unadvise: vi.fn(() => { order.push('unadvise'); }) };
  const bindings = { ...comBindings(), releasePoint: vi.fn(() => { pointReferences--; dispatchReferences--; order.push('point-release'); }) };
  bindings.points.mockImplementation(() => { pointReferences++; dispatchReferences++; return [point] as never[]; });
  bindings.releaseObject.mockImplementation(() => { order.push('release'); });
  bindings.uninitialize.mockImplementation(() => { remainingAtUninitialize = pointReferences + dispatchReferences; order.push('uninitialize'); });
  using session = createComSession(bindings);
  const attached = session.attachOutlook();
  expect(session.subscribeNewMail(attached.object, listener)).toBe(true);
  sink!.NewMailEx('E1');
  expect(listener).toHaveBeenCalledWith('E1');
  session.pump();
  expect(bindings.pump).toHaveBeenCalledOnce();
  session.close();
  expect(point.unadvise).toHaveBeenCalledWith(7);
  expect(bindings.releasePoint).toHaveBeenCalledWith(point);
  expect(remainingAtUninitialize).toBe(0);
  expect(order).toEqual(['unadvise', 'point-release', 'release', 'uninitialize']);
});

test.each(['selected', 'ignored', 'failed-advice'])('event capability without deterministic disposal refuses before enumerating %s wrappers', (kind) => {
  let pointReferences = 0, dispatchReferences = 0;
  const point = { getMethods: () => kind === 'ignored' ? ['OtherEvent'] : ['NewMailEx'],
    advise: vi.fn(() => { if (kind === 'failed-advice') throw new Error('fixture advice failure'); return 7; }), unadvise: vi.fn() };
  const bindings = comBindings();
  bindings.points.mockImplementation(() => { pointReferences++; dispatchReferences++; return [point] as never[]; });
  using session = createComSession(bindings);
  const attached = session.attachOutlook();
  expect(session.subscribeNewMail(attached.object, vi.fn())).toBe(false);
  expect(bindings.points).not.toHaveBeenCalled();
  expect(point.advise).not.toHaveBeenCalled();
  expect([pointReferences, dispatchReferences]).toEqual([0, 0]);
  session.close();
  expect(bindings.releaseObject).toHaveBeenCalledOnce();
  expect(bindings.uninitialize).toHaveBeenCalledOnce();
});

test('supported disposal releases ignored, failed-advice and post-selection owners before apartment shutdown', () => {
  const live = new Set<unknown>();
  let pointReferences = 0, dispatchReferences = 0, remainingAtUninitialize = -1;
  const make = (methods: string[], fail = false) => ({ getMethods: () => methods,
    advise: vi.fn(() => { if (fail) throw new Error('fixture advice failure'); return 7; }), unadvise: vi.fn() });
  const ignored = make(['OtherEvent']), failed = make(['NewMailEx'], true), selected = make(['NewMailEx']), after = make(['OtherEvent']);
  const points = [ignored, failed, selected, after];
  const bindings = { ...comBindings(), releasePoint: vi.fn((point: unknown) => {
    expect(live.delete(point)).toBe(true); pointReferences--; dispatchReferences--;
  }) };
  bindings.points.mockImplementation(() => { for (const point of points) { live.add(point); pointReferences++; dispatchReferences++; } return points as never[]; });
  bindings.uninitialize.mockImplementation(() => { remainingAtUninitialize = pointReferences + dispatchReferences; });
  using session = createComSession(bindings);
  expect(session.subscribeNewMail(session.attachOutlook().object, vi.fn())).toBe(true);
  expect([...live]).toEqual([selected]);
  expect([pointReferences, dispatchReferences]).toEqual([1, 1]);
  session.close();
  expect(selected.unadvise).toHaveBeenCalledWith(7);
  expect(ignored.unadvise).not.toHaveBeenCalled(); expect(failed.unadvise).not.toHaveBeenCalled(); expect(after.unadvise).not.toHaveBeenCalled();
  expect(bindings.releasePoint).toHaveBeenCalledTimes(4);
  expect(remainingAtUninitialize).toBe(0);
});

test('an unadvise error still disposes point and retained dispatch owners before uninitialization', () => {
  let pointReferences = 0, dispatchReferences = 0, remainingAtUninitialize = -1;
  const point = { getMethods: () => ['NewMailEx'], advise: () => 7, unadvise: () => { throw new Error('fixture unadvise failure'); } };
  const bindings = { ...comBindings(), releasePoint: vi.fn(() => { pointReferences--; dispatchReferences--; }) };
  bindings.points.mockImplementation(() => { pointReferences++; dispatchReferences++; return [point] as never[]; });
  bindings.uninitialize.mockImplementation(() => { remainingAtUninitialize = pointReferences + dispatchReferences; });
  using session = createComSession(bindings);
  expect(session.subscribeNewMail(session.attachOutlook().object, vi.fn())).toBe(true);
  expect(() => session.close()).toThrow(/com.cleanup/);
  expect(bindings.releasePoint).toHaveBeenCalledOnce();
  expect(remainingAtUninitialize).toBe(0);
});

test('pinned winax refuses optional events before calling its unsafe enumeration API', () => {
  const winax = createRequire(import.meta.url)('winax') as { getConnectionPoints(object: unknown): unknown[] };
  const enumerate = vi.spyOn(winax, 'getConnectionPoints').mockImplementation(() => { throw new Error('fixture enumeration forbidden'); });
  const session = createComSession();
  try {
    expect(session.subscribeNewMail({ fixture: true }, vi.fn())).toBe(false);
    expect(enumerate).not.toHaveBeenCalled();
  } finally { session.close(); enumerate.mockRestore(); }
});

test('DPAPI forbids UI, wipes native clear output, frees output even after a copy failure', () => {
  const output = Buffer.from('synthetic clear');
  const bindings = {
    transform: vi.fn((_input: Buffer, _protect: boolean, flags: number) => { expect(flags).toBe(1); return { pointer: 9n, size: output.length }; }),
    copy: vi.fn(() => Buffer.from(output)), zero: vi.fn(() => { output.fill(0); }), free: vi.fn(() => true),
  };
  const dpapi = createDpapi(bindings);
  expect(dpapi.unprotect(Buffer.from('encrypted'))).toEqual(Buffer.from('synthetic clear'));
  expect(output.every((byte) => byte === 0)).toBe(true);
  expect(bindings.free.mock.calls).toEqual([[9n]]);
  bindings.copy.mockImplementation(() => { throw new Error('synthetic copy failure'); });
  expect(() => dpapi.unprotect(Buffer.from('encrypted'))).toThrow(/dpapi.copy/);
  expect(bindings.free).toHaveBeenCalledTimes(2);
});

test.each(['protect', 'unprotect'] as const)('failed native DPAPI %s captures status before freeing a non-null output', async (operation) => {
  const ffi = win32Ffi(), blob = {};
  const order: string[] = [];
  let status = 5, inputCopy: Buffer | undefined;
  const struct = vi.spyOn(ffi, 'struct').mockReturnValue(blob);
  const sizeof = vi.spyOn(ffi, 'sizeof').mockReturnValue(16);
  const offsetof = vi.spyOn(ffi, 'offsetof').mockReturnValue(8);
  const load = vi.spyOn(ffi, 'load').mockImplementation(() => ({ func(signature: string) {
    if (/Crypt(?:Unprotect|Protect)Data/.test(signature)) return (...args: any[]) => {
      order.push('crypt'); status = 5; inputCopy = args[0].pbData;
      expect(args[5]).toBe(1);
      Object.assign(args.at(-1), { pbData: 9n, cbData: 0 }); return 0;
    };
    if (signature.includes('LocalFree')) return (pointer: bigint) => { expect(pointer).toBe(9n); order.push('free'); status = 111; return null; };
    if (signature.includes('GetLastError')) return () => { order.push('last'); return status; };
    throw new Error('fixture unexpected native signature');
  } }));
  try {
    vi.resetModules();
    const { createDpapi: fresh } = await import('../src/windows/dpapi.ts');
    const original = Buffer.from('owned synthetic input');
    let failure: unknown;
    try { fresh()[operation](original); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'dpapi.transform', status: 5 });
    expect(order).toEqual(['crypt', 'last', 'free']);
    expect(inputCopy?.every((byte) => byte === 0)).toBe(true);
    expect(original.toString()).toBe('owned synthetic input');
  } finally { load.mockRestore(); offsetof.mockRestore(); sizeof.mockRestore(); struct.mockRestore(); }
});

test('real DPAPI scratch round trip never returns plaintext as protected bytes', () => {
  const dpapi = createDpapi();
  const clear = Buffer.from('synthetic dispatcher native fixture');
  const protectedBytes = dpapi.protect(clear);
  expect(protectedBytes.equals(clear)).toBe(false);
  expect(dpapi.unprotect(protectedBytes)).toEqual(clear);
  expect(clear.toString()).toBe('synthetic dispatcher native fixture');
});

function cookieFixture() {
  const { root } = scratch('phase7-native-');
  const path = join(root, 'Cookies');
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,encrypted_value BLOB);");
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  const main = fs.readFileSync(path);
  const bytes = Buffer.from('v10synthetic encrypted row, not a token');
  db.prepare("INSERT INTO cookies VALUES('fixture.asyncgw.teams.microsoft.com','authtoken_asm','/',?)").run(bytes);
  const capture: [Buffer, Buffer] = [fs.readFileSync(path), fs.readFileSync(path + '-wal')];
  fs.writeFileSync(join(root, 'captured-main.bin'), capture[0]);
  fs.writeFileSync(join(root, 'captured-wal.bin'), capture[1]);
  return { db, path, root, main, bytes, capture };
}

test('actual encrypted SQLite WAL replay returns one row, main-only negative control returns zero, copied bytes stay exact', () => {
  const fixture = cookieFixture();
  try {
    expect(fixture.main.equals(fixture.capture[0])).toBe(true);
    expect(fixture.capture[1].length).toBeGreaterThan(32);
    const withWal = cookieSnapshotRows(fixture.capture, fixture.root);
    const mainOnly = cookieSnapshotRows([fixture.capture[0], null], fixture.root);
    expect(withWal.version).toBe(24);
    expect(withWal.rows).toHaveLength(1);
    expect(Buffer.from(withWal.rows[0]!.encrypted_value)).toEqual(fixture.bytes);
    expect(mainOnly.rows).toHaveLength(0);
    expect(fs.readFileSync(join(withWal.directory, 'Cookies'))).toEqual(fixture.capture[0]);
    expect(fs.readFileSync(join(withWal.directory, 'Cookies-wal'))).toEqual(fixture.capture[1]);
    expect([fs.readFileSync(fixture.path), fs.readFileSync(fixture.path + '-wal')]).toEqual(fixture.capture);
  } finally { fixture.db.close(); }
  expect(fixture.db.isOpen).toBe(false);
});

test('absent WAL differs from an empty WAL and byte changes cannot pass coherence', () => {
  expect(sameCapture([Buffer.from('db'), null], [Buffer.from('db'), null])).toBe(true);
  expect(sameCapture([Buffer.from('db'), null], [Buffer.from('db'), Buffer.alloc(0)])).toBe(false);
  expect(sameCapture([Buffer.from('db'), Buffer.from('wal')], [Buffer.from('db'), Buffer.from('changed')])).toBe(false);
});

function snapshotFiles(capture: [Buffer, Buffer | null]) {
  const closed: bigint[] = [];
  const files = {
    shared: vi.fn((_path: string) => ({ handle: null, error: 32 })),
    present: vi.fn((path: string) => !path.endsWith('-wal') || capture[1] !== null),
    liveHandles: vi.fn((paths: string[]) => new Map(paths.map((path) => [path, path.endsWith('-wal') ? 2n : 1n]))),
    validate: vi.fn(), identity: vi.fn(() => Buffer.from('identity')), currentIdentity: vi.fn(() => Buffer.from('identity')),
    mapped: vi.fn((handle: bigint) => Buffer.from(capture[handle === 1n ? 0 : 1]!)), close: vi.fn((handle: bigint) => { closed.push(handle); }),
  } satisfies SnapshotFiles;
  return { files, closed };
}

test('locked stable snapshot uses only acquired duplicates and closes every owned handle', async () => {
  const fixture = cookieFixture();
  try {
    const { files, closed } = snapshotFiles(fixture.capture);
    const result = await snapshotCookies(fixture.path, fixture.root, files);
    expect(result.rows).toHaveLength(1);
    expect(result.walPresent).toBe(true);
    expect(files.liveHandles).toHaveBeenCalledWith([fixture.path, fixture.path + '-wal']);
    expect(closed.sort()).toEqual([1n, 2n]);
  } finally { fixture.db.close(); }
});

test('identity validation failure after the first open still closes that acquired handle', async () => {
  const { root } = scratch('phase7-acquire-failure-');
  const { files, closed } = snapshotFiles([Buffer.from('synthetic'), null]);
  files.shared.mockReturnValue({ handle: 1n as unknown as null, error: null as unknown as number });
  files.validate.mockImplementation(() => { throw new Error('synthetic identity failure'); });
  await expect(snapshotCookies(join(root, 'Cookies'), root, files)).rejects.toThrow(/snapshot/);
  expect(closed).toEqual([1n, 1n, 1n]);
});

test('changing recapture fails after exactly three attempts and all duplicates close', async () => {
  const fixture = cookieFixture();
  try {
    const { files, closed } = snapshotFiles(fixture.capture);
    let reads = 0;
    files.mapped.mockImplementation((handle) => {
      reads++;
      return handle === 1n && reads % 4 === 3 ? Buffer.from('changed') : Buffer.from(fixture.capture[handle === 1n ? 0 : 1]);
    });
    await expect(snapshotCookies(fixture.path, fixture.root, files)).rejects.toThrow(/snapshot/);
    expect(files.liveHandles).toHaveBeenCalledTimes(3);
    expect(closed).toHaveLength(6);
  } finally { fixture.db.close(); }
});

test('actual scratch shared mapping validates identity and leaves zero owned resources', () => {
  const { root } = scratch('phase7-map-');
  const path = join(root, 'synthetic encrypted.bin');
  const bytes = Buffer.from('synthetic encrypted fixture');
  fs.writeFileSync(path, bytes);
  using native = createKernel();
  const { handle } = native.shared(path);
  expect(handle).toBeTruthy();
  try {
    native.validate(handle!, path);
    expect(native.identity(handle!)).toEqual(native.currentIdentity(path));
    expect(native.mapped(handle!)).toEqual(bytes);
  } finally { native.close(handle!); }
  expect(native.resources.size).toBe(0);
});

test('native identity reads only this test process and closes its query handle', () => {
  using native = createKernel();
  const identity = native.processIdentity(process.pid);
  expect(identity.pid).toBe(process.pid);
  expect(BigInt(identity.created)).toBeGreaterThan(0n);
  expect(identity.image.toLowerCase()).toBe(process.execPath.toLowerCase());
  expect(native.resources.size).toBe(0);
});
