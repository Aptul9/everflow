import { createRequire } from 'node:module';
import { isAbsolute, win32 } from 'node:path';

export type NativeBindings = Record<string, (...args: any[]) => any>;
export type ProcessRow = { pid: number; parent: number; exe: string };
export type LaunchOptions = { executable: string; args: string[]; cwd: string; environment: Record<string, string>; breakaway?: boolean };
export type ProcessIdentity = { pid: number; created: string; image: string };
const MiB = 1024 * 1024;

export class NativeError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  constructor(code: string, status?: number) { super(code); this.name = 'NativeError'; this.code = code; this.status = status; }
}

const require = createRequire(import.meta.url);
let ffi: any;
export function win32Ffi(): any {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new NativeError('native.windows-x64-required');
  return ffi ??= require('koffi');
}

export function windowsPath(path: string): string {
  const plain = path.startsWith('\\\\?\\UNC\\') ? '\\\\' + path.slice(8) : path.startsWith('\\\\?\\') ? path.slice(4) : path;
  return win32.resolve(plain).toLowerCase();
}

function invalid(pointer: bigint | null | undefined): boolean {
  return typeof pointer !== 'bigint' || pointer === 0n || BigInt.asUintN(64, pointer) === 0xffffffffffffffffn;
}

export class NativeResources {
  private readonly owned = new Map<string, { pointer: bigint; kind: string }>();
  private readonly release: (kind: string, pointer: bigint) => boolean;
  constructor(release: (kind: string, pointer: bigint) => boolean) { this.release = release; }
  get size() { return this.owned.size; }
  has(pointer: bigint, kind: string) { return this.owned.has(`${kind}:${pointer}`); }
  own(pointer: bigint, kind: string): bigint {
    if (invalid(pointer)) throw new NativeError('native.invalid-handle');
    const key = `${kind}:${pointer}`;
    if (this.owned.has(key)) throw new NativeError('native.duplicate-owner');
    this.owned.set(key, { pointer, kind });
    return pointer;
  }
  close(pointer: bigint, kind: string): void {
    const key = `${kind}:${pointer}`;
    if (!this.owned.has(key)) throw new NativeError('native.unowned');
    if (!this.release(kind, pointer)) throw new NativeError('native.cleanup');
    this.owned.delete(key);
  }
  dispose(): void {
    let failed = false;
    for (const { pointer, kind } of [...this.owned.values()].reverse()) {
      try { this.close(pointer, kind); } catch { failed = true; }
    }
    if (failed) throw new NativeError('native.cleanup');
  }
  [Symbol.dispose]() { this.dispose(); }
}

export function quoteWindowsArgument(value: string): string {
  if (value.includes('\0')) throw new NativeError('native.invalid-argument');
  if (value && !/[\s"]/.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

export function teamsDescendants(rows: ProcessRow[]): number[] {
  const selected = new Set(rows.filter((row) => row.exe.toLowerCase() === 'ms-teams.exe').map((row) => row.pid));
  for (;;) {
    const count = selected.size;
    for (const row of rows) if (selected.has(row.parent) && row.exe.toLowerCase() === 'msedgewebview2.exe') selected.add(row.pid);
    if (count === selected.size) return [...selected].sort((a, b) => a - b);
  }
}

export function parseHandleInventory(bytes: Buffer, returned: number, selected?: Set<number>): { pid: number; handle: bigint; access: number }[] {
  if (!Number.isSafeInteger(returned) || returned < 16 || returned > bytes.length || bytes.length > 128 * MiB) throw new NativeError('native.handle-inventory');
  const count = bytes.readBigUInt64LE(0);
  if (count > BigInt(Math.floor((returned - 16) / 40))) throw new NativeError('native.handle-inventory');
  const rows = [];
  for (let index = 0; index < Number(count); index++) {
    const at = 16 + index * 40;
    const pid = bytes.readBigUInt64LE(at + 8);
    if (pid > 0xffffffffn || selected && !selected.has(Number(pid))) continue;
    rows.push({ pid: Number(pid), handle: bytes.readBigUInt64LE(at + 16), access: bytes.readUInt32LE(at + 24) });
  }
  return rows;
}

let bindings: NativeBindings | undefined;
function kernelBindings(): NativeBindings {
  if (bindings) return bindings;
  const koffi = win32Ffi();
  const kernel = koffi.load('kernel32.dll');
  const nt = koffi.load('ntdll.dll');
  const process = koffi.struct('DispatcherProcessEntry', {
    size: 'uint32_t', usage: 'uint32_t', pid: 'uint32_t', heap: 'uintptr_t', module: 'uint32_t',
    threads: 'uint32_t', parent: 'uint32_t', priority: 'int32_t', flags: 'uint32_t', exe: koffi.array('uint16_t', 260),
  });
  const entry = koffi.struct('DispatcherHandleEntry', { object: 'void *', pid: 'uintptr_t', handle: 'uintptr_t', access: 'uint32_t', trace: 'uint16_t', type: 'uint16_t', attributes: 'uint32_t', reserved: 'uint32_t' });
  const startup = koffi.struct('DispatcherStartup', {
    cb: 'uint32_t', reserved: 'void *', desktop: 'void *', title: 'void *', x: 'uint32_t', y: 'uint32_t', xSize: 'uint32_t', ySize: 'uint32_t',
    xChars: 'uint32_t', yChars: 'uint32_t', fill: 'uint32_t', flags: 'uint32_t', show: 'uint16_t', reservedBytes: 'uint16_t',
    reservedPointer: 'void *', input: 'void *', output: 'void *', error: 'void *',
  });
  const information = koffi.struct('DispatcherProcessInformation', { process: 'void *', thread: 'void *', pid: 'uint32_t', tid: 'uint32_t' });
  if (koffi.sizeof('void *') !== 8 || koffi.sizeof(process) !== 568 || koffi.offsetof(process, 'exe') !== 44 || koffi.offsetof(process, 'parent') !== 32
    || koffi.sizeof(entry) !== 40 || koffi.offsetof(entry, 'pid') !== 8 || koffi.offsetof(entry, 'access') !== 24 || koffi.sizeof(startup) !== 104 || koffi.sizeof(information) !== 24) throw new NativeError('native.abi-layout');
  const declarations = [
    'void *__stdcall GetCurrentProcess()', 'uint32_t __stdcall GetLastError()', 'int __stdcall CloseHandle(void *handle)',
    'int __stdcall UnmapViewOfFile(void *view)', 'void *__stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)',
    'int __stdcall Process32FirstW(void *snapshot, void *entry)', 'int __stdcall Process32NextW(void *snapshot, void *entry)',
    'void *__stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)',
    'int __stdcall DuplicateHandle(void *sourceProcess, void *source, void *targetProcess, _Out_ void **target, uint32_t access, int inherit, uint32_t options)',
    'uint32_t __stdcall GetFileType(void *handle)', 'uint32_t __stdcall GetFinalPathNameByHandleW(void *handle, void *name, uint32_t length, uint32_t flags)',
    'int __stdcall GetFileSizeEx(void *handle, _Out_ int64_t *size)', 'int __stdcall GetFileInformationByHandle(void *handle, void *info)',
    'uint32_t __stdcall GetFileAttributesW(str16 path)',
    'void *__stdcall CreateFileW(str16 path, uint32_t access, uint32_t sharing, void *security, uint32_t disposition, uint32_t flags, void *templateFile)',
    'void *__stdcall CreateFileMappingW(void *file, void *security, uint32_t protect, uint32_t high, uint32_t low, str16 name)',
    'void *__stdcall MapViewOfFile(void *mapping, uint32_t access, uint32_t high, uint32_t low, size_t size)',
    'int __stdcall IsProcessInJob(void *process, void *job, _Out_ int *result)',
    'int __stdcall GetProcessTimes(void *process, void *created, void *exited, void *kernel, void *user)',
    'uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)',
    'int __stdcall TerminateProcess(void *process, uint32_t exitCode)',
    'int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *name, _Inout_ uint32_t *size)',
    'int __stdcall CreateProcessW(str16 application, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, str16 directory, const DispatcherStartup *startup, _Out_ DispatcherProcessInformation *result)',
  ];
  bindings = Object.fromEntries(declarations.map((declaration) => [declaration.match(/(\w+)\(/)![1]!, kernel.func(declaration)]));
  bindings.NtQuerySystemInformation = nt.func('int32_t __stdcall NtQuerySystemInformation(uint32_t infoClass, void *buffer, uint32_t size, _Out_ uint32_t *needed)');
  return bindings;
}

export function createKernel(input?: NativeBindings) {
  const api = input ?? kernelBindings();
  const error = (code: string) => new NativeError(code, api.GetLastError!());
  const resources = new NativeResources((kind, pointer) => Boolean(kind === 'view' ? api.UnmapViewOfFile!(pointer) : api.CloseHandle!(pointer)));
  const own = (pointer: bigint | null, kind = 'handle'): bigint => { if (invalid(pointer)) throw error('native.open-failed'); return resources.own(pointer!, kind); };
  const close = (handle: bigint) => resources.close(handle, 'handle');
  const owned = (handle: bigint) => { if (!resources.has(handle, 'handle')) throw new NativeError('native.unowned'); };
  function pathOf(handle: bigint): string {
    owned(handle);
    if (api.GetFileType!(handle) !== 1) throw new NativeError('native.not-disk-file');
    const bytes = Buffer.alloc(32768 * 2);
    const length = api.GetFinalPathNameByHandleW!(handle, bytes, 32768, 0) as number;
    if (!length) throw error('native.file-path');
    if (length >= 32768) throw new NativeError('native.file-path-limit');
    return windowsPath(bytes.toString('utf16le', 0, length * 2));
  }
  function validate(handle: bigint, path: string): void {
    if (pathOf(handle) !== windowsPath(path)) throw new NativeError('native.file-path-mismatch');
  }
  function size(handle: bigint, limit = 64 * MiB): number {
    owned(handle);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64 * MiB) throw new NativeError('native.mapping-size');
    const result: (bigint | number)[] = [0n];
    if (!api.GetFileSizeEx!(handle, result)) throw error('native.file-size');
    const value = Number(result[0]);
    if (!Number.isSafeInteger(value) || value < 0 || value > limit) throw new NativeError('native.mapping-size');
    return value;
  }
  function identity(handle: bigint): Buffer {
    owned(handle);
    const info = Buffer.alloc(52);
    if (!api.GetFileInformationByHandle!(handle, info)) throw error('native.file-identity');
    return Buffer.concat([info.subarray(28, 32), info.subarray(44, 52)]);
  }
  function processes(): ProcessRow[] {
    const handle = own(api.CreateToolhelp32Snapshot!(2, 0));
    try {
      const bytes = Buffer.alloc(568); bytes.writeUInt32LE(568);
      let more = api.Process32FirstW!(handle, bytes);
      if (!more) throw error('native.process-inventory');
      const rows = [];
      while (more) {
        if (rows.length >= 65536) throw new NativeError('native.process-inventory-limit');
        rows.push({ pid: bytes.readUInt32LE(8), parent: bytes.readUInt32LE(32), exe: bytes.toString('utf16le', 44, 564).split('\0')[0]! });
        more = api.Process32NextW!(handle, bytes);
      }
      if (api.GetLastError!() !== 18) throw error('native.process-inventory');
      return rows;
    } finally { close(handle); }
  }
  function processInfo(handle: bigint, pid: number): ProcessIdentity {
    const created = Buffer.alloc(8);
    if (!api.GetProcessTimes!(handle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) throw error('native.process-times');
    const name = Buffer.alloc(32768 * 2), length = [32768];
    if (!api.QueryFullProcessImageNameW!(handle, 0, name, length)) throw error('native.process-image');
    if (!length[0] || length[0] >= 32768) throw new NativeError('native.process-image-limit');
    return { pid, created: created.readBigUInt64LE(0).toString(), image: name.toString('utf16le', 0, length[0] * 2) };
  }
  function checkPid(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new NativeError('native.invalid-pid');
  }
  function matching(identity: ProcessIdentity, access: number, action: (handle: bigint) => boolean, absent: boolean): boolean {
    checkPid(identity.pid);
    if (!/^\d+$/.test(identity.created) || !isAbsolute(identity.image)) throw new NativeError('native.invalid-process-identity');
    const pointer = api.OpenProcess!(access | 0x101000, 0, identity.pid) as bigint | null;
    if (invalid(pointer)) {
      const status = api.GetLastError!();
      if (status === 87 || status === 1168) return absent;
      throw new NativeError('native.process-open', status);
    }
    const handle = own(pointer);
    try {
      if (waiting(handle, 0)) return absent;
      let actual: ProcessIdentity;
      try { actual = processInfo(handle, identity.pid); }
      catch (failure) { if (waiting(handle, 0)) return absent; throw failure; }
      if (actual.created !== identity.created || windowsPath(actual.image) !== windowsPath(identity.image)) return absent;
      return action(handle);
    } finally { close(handle); }
  }
  function waiting(handle: bigint, milliseconds: number): boolean {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 120000) throw new NativeError('native.wait-limit');
    const result = api.WaitForSingleObject!(handle, milliseconds) as number;
    if (result === 0) return true;
    if (result === 258) return false;
    throw error('native.process-wait');
  }
  function inJob(): boolean {
    const result = [0];
    if (!api.IsProcessInJob!(api.GetCurrentProcess!(), null, result)) throw error('native.job-query');
    return result[0] !== 0;
  }
  function launch(options: LaunchOptions, capture: boolean): number | ProcessIdentity {
    if (!isAbsolute(options.executable) || !isAbsolute(options.cwd) || /\0/.test(options.executable + options.cwd)) throw new NativeError('native.invalid-argument');
    // Unidentified outer containment is retained unless the caller explicitly requests the supported breakaway mode.
    const breakaway = options.breakaway !== false;
    if (inJob() && breakaway) throw new NativeError('native.outer-job');
    const command = [options.executable, ...options.args].map(quoteWindowsArgument).join(' ');
    if (command.length >= 32767) throw new NativeError('native.command-limit');
    const names = new Set<string>();
    const environment = Object.entries(options.environment).sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase())).map(([name, value]) => {
      if (!name || /[=\0]/.test(name) || value.includes('\0') || names.has(name.toLowerCase())) throw new NativeError('native.invalid-environment');
      names.add(name.toLowerCase()); return `${name}=${value}`;
    }).join('\0') + '\0\0';
    const startup = { cb: 104, reserved: null, desktop: null, title: null, x: 0, y: 0, xSize: 0, ySize: 0, xChars: 0, yChars: 0,
      fill: 0, flags: 1, show: 0, reservedBytes: 0, reservedPointer: null, input: null, output: null, error: null };
    const result: { process?: bigint; thread?: bigint; pid?: number } = {};
    if (!api.CreateProcessW!(options.executable, Buffer.from(command + '\0', 'utf16le'), null, null, 0, breakaway ? 0x09000600 : 0x08000600, Buffer.from(environment, 'utf16le'), options.cwd, startup, result)) throw error('native.create-process');
    const processHandle = own(result.process ?? null);
    try {
      const thread = own(result.thread ?? null);
      try {
        if (!result.pid) throw new NativeError('native.invalid-pid');
        if (!capture) return result.pid;
        try { return processInfo(processHandle, result.pid); }
        catch (failure) {
          // This is still the handle returned by CreateProcess, never a reopened PID.
          if (!waiting(processHandle, 0) && (!api.TerminateProcess!(processHandle, 1) || !waiting(processHandle, 5000))) throw error('native.launch-cleanup');
          throw failure;
        }
      } finally { close(thread); }
    } finally { close(processHandle); }
  }
  return {
    resources,
    processes,
    inJob,
    processIdentity(pid: number): ProcessIdentity {
      checkPid(pid);
      const handle = own(api.OpenProcess!(0x1000, 0, pid));
      try { return processInfo(handle, pid); } finally { close(handle); }
    },
    launch(options: LaunchOptions): number { return launch(options, false) as number; },
    launchIdentity(options: LaunchOptions): ProcessIdentity { return launch(options, true) as ProcessIdentity; },
    running(identity: ProcessIdentity): boolean { return matching(identity, 0, (handle) => !waiting(handle, 0), false); },
    wait(identity: ProcessIdentity, milliseconds: number): boolean { return matching(identity, 0, (handle) => waiting(handle, milliseconds), true); },
    terminate(identity: ProcessIdentity): boolean {
      if (identity.pid === process.pid) throw new NativeError('native.self-termination');
      return matching(identity, 1, (handle) => {
        if (waiting(handle, 0)) return false;
        if (!api.TerminateProcess!(handle, 1)) { const failure = error('native.process-terminate'); if (waiting(handle, 0)) return false; throw failure; }
        if (!waiting(handle, 5000)) throw new NativeError('native.process-exit-timeout');
        return true;
      }, false);
    },
    shared(path: string): { handle: bigint | null; error: number | null } {
      const handle = api.CreateFileW!(path, 0x80000000, 7, null, 3, 0, null) as bigint | null;
      return invalid(handle) ? { handle: null, error: api.GetLastError!() } : { handle: own(handle), error: null };
    },
    present(path: string): boolean {
      if (api.GetFileAttributesW!(path) !== 0xffffffff) return true;
      const code = api.GetLastError!() as number;
      if (code === 2 || code === 3) return false;
      throw new NativeError('native.file-attributes', code);
    },
    liveHandles(paths: string[]): Map<string, bigint> {
      const selected = new Set(teamsDescendants(processes()));
      if (!selected.size) throw new NativeError('native.teams-not-running');
      let length = MiB, bytes: Buffer | undefined, returned = 0;
      while (length <= 128 * MiB) {
        const candidate = Buffer.alloc(length), needed = [0];
        const status = api.NtQuerySystemInformation!(64, candidate, length, needed) >>> 0;
        if (!status) { bytes = candidate; returned = needed[0] || length; break; }
        if (status !== 0xc0000004) throw new NativeError('native.handle-inventory-query', status);
        length = Math.max(length * 2, needed[0]! + 65536);
      }
      if (!bytes) throw new NativeError('native.handle-inventory-limit');
      const wanted = new Map(paths.map((path) => [windowsPath(path), path]));
      const processHandles = new Map<number, bigint | null>(), found = new Map<string, bigint>();
      try {
        for (const entry of parseHandleInventory(bytes, returned, selected)) {
          if (found.size === wanted.size) break;
          if (!(entry.access & 1)) continue;
          if (!processHandles.has(entry.pid)) {
            const source = api.OpenProcess!(0x40, 0, entry.pid) as bigint | null;
            processHandles.set(entry.pid, invalid(source) ? null : own(source));
          }
          const source = processHandles.get(entry.pid);
          if (!source) continue;
          const result: (bigint | null)[] = [null];
          if (!api.DuplicateHandle!(source, entry.handle, api.GetCurrentProcess!(), result, 0x81, 0, 0)) continue;
          const handle = own(result[0]!);
          let keep = false;
          try {
            if (api.GetFileType!(handle) !== 1) continue;
            const path = wanted.get(pathOf(handle));
            if (path && !found.has(path)) { validate(handle, path); size(handle); found.set(path, handle); keep = true; }
          } finally { if (!keep) close(handle); }
        }
        return found;
      } catch (cause) {
        for (const handle of found.values()) close(handle);
        throw cause;
      } finally { for (const handle of processHandles.values()) if (handle) close(handle); }
    },
    validate, identity,
    currentIdentity(path: string): Buffer {
      const handle = own(api.CreateFileW!(path, 0, 7, null, 3, 0, null));
      try { validate(handle, path); return identity(handle); } finally { close(handle); }
    },
    mapped(handle: bigint, limit = 64 * MiB): Buffer {
      const length = size(handle, limit);
      if (!length) return Buffer.alloc(0);
      const mapping = own(api.CreateFileMappingW!(handle, null, 2, 0, 0, null));
      try {
        const view = own(api.MapViewOfFile!(mapping, 4, 0, 0, length), 'view');
        try {
          const bytes = Buffer.from(new Uint8Array(win32Ffi().view(view, length)));
          if (size(handle, limit) !== length) throw new NativeError('native.file-size-changed');
          return bytes;
        } finally { resources.close(view, 'view'); }
      } finally { close(mapping); }
    },
    close,
    [Symbol.dispose]() { resources.dispose(); },
  };
}
