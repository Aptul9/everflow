import fs from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createKernel, NativeError } from './kernel.ts';

export type CookieCapture = [Buffer, Buffer | null];
export type CookieRow = { host_key: string; name: string; path: string; encrypted_value: Uint8Array };
export type SnapshotFiles = Pick<ReturnType<typeof createKernel>, 'shared' | 'present' | 'liveHandles' | 'validate' | 'identity' | 'currentIdentity' | 'mapped' | 'close'>;

export function sameCapture(before: CookieCapture, after: CookieCapture): boolean {
  return before[0].equals(after[0]) && (before[1] === null ? after[1] === null : after[1] !== null && before[1].equals(after[1]));
}

export function cookieSnapshotRows(capture: CookieCapture, scratchRoot: string): { rows: CookieRow[]; version: number; directory: string } {
  if (!isAbsolute(scratchRoot) || !capture[0].length || capture.some((bytes) => bytes && bytes.length > 64 * 1024 * 1024)) throw new NativeError('snapshot.invalid-input');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const directory = fs.mkdtempSync(join(scratchRoot, 'cookies-'));
  const path = join(directory, 'Cookies');
  fs.writeFileSync(path, capture[0], { flag: 'wx' });
  if (capture[1] !== null) fs.writeFileSync(path + '-wal', capture[1], { flag: 'wx' });
  let db: DatabaseSync | undefined;
  let rows: CookieRow[], version: number;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    const checks = db.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || Object.values(checks[0]!)[0] !== 'ok') throw new NativeError('snapshot.quick-check');
    version = Number(db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value);
    if (!Number.isSafeInteger(version) || version < 0) throw new NativeError('snapshot.cookie-version');
    const selected = db.prepare("SELECT host_key,name,path,encrypted_value FROM cookies WHERE name IN ('authtoken','authtoken_asm') LIMIT 10001").all();
    if (selected.length > 10000) throw new NativeError('snapshot.cookie-row-limit');
    rows = selected.map((row) => {
      if (typeof row.host_key !== 'string' || typeof row.name !== 'string' || typeof row.path !== 'string' || !(row.encrypted_value instanceof Uint8Array)) throw new NativeError('snapshot.cookie-row');
      return { host_key: row.host_key, name: row.name, path: row.path, encrypted_value: Buffer.from(row.encrypted_value) };
    });
  } catch (error) {
    if (error instanceof NativeError) throw error;
    throw new NativeError('snapshot.sqlite-read');
  } finally { db?.close(); }
  const wal = fs.existsSync(path + '-wal') ? fs.readFileSync(path + '-wal') : null;
  // SQLite may create a zero-byte reader WAL only on a main-only scratch copy.
  if (!fs.readFileSync(path).equals(capture[0]) || (capture[1] === null ? wal !== null && wal.length !== 0 : wal === null || !wal.equals(capture[1]))) throw new NativeError('snapshot.copy-changed');
  return { rows, version, directory };
}

export async function snapshotCookies(path: string, scratchRoot: string, input?: SnapshotFiles, signal?: AbortSignal) {
  if (!isAbsolute(path)) throw new NativeError('snapshot.absolute-source-required');
  const native = input ? undefined : createKernel();
  const files = input ?? native!;
  const paths = [path, path + '-wal'];
  let last = new NativeError('snapshot.unavailable');
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const handles = new Map<string, bigint>();
      try {
        if (signal?.aborted) throw new NativeError('snapshot.aborted');
        for (const filename of paths) {
          const result = files.shared(filename);
          if (result.handle) { handles.set(filename, result.handle); files.validate(result.handle, filename); }
          else if (![2, 3, 32, 33].includes(result.error!)) throw new NativeError('snapshot.shared-open', result.error!);
        }
        const missing = paths.filter((filename) => !handles.has(filename) && files.present(filename));
        if (missing.length) {
          for (const [filename, handle] of files.liveHandles(missing)) handles.set(filename, handle);
        }
        if (!handles.has(path) || paths.some((filename) => files.present(filename) && !handles.has(filename))) throw new NativeError('snapshot.source-unavailable');
        const identities = new Map([...handles].map(([filename, handle]) => [filename, files.identity(handle)]));
        const capture = (): CookieCapture => {
          if (signal?.aborted) throw new NativeError('snapshot.aborted');
          for (const filename of paths) {
            if (files.present(filename) !== handles.has(filename)) throw new NativeError('snapshot.existence-changed');
            const handle = handles.get(filename);
            if (handle) {
              files.validate(handle, filename);
              if (!identities.get(filename)!.equals(files.currentIdentity(filename))) throw new NativeError('snapshot.identity-changed');
            }
          }
          return [files.mapped(handles.get(path)!), handles.has(path + '-wal') ? files.mapped(handles.get(path + '-wal')!) : null];
        };
        const before = capture();
        const result = cookieSnapshotRows(before, scratchRoot);
        const after = capture();
        if (!sameCapture(before, after)) throw new NativeError('snapshot.bytes-changed');
        return { ...result, walPresent: before[1] !== null };
      } catch (error) {
        last = error instanceof NativeError && error.code.startsWith('snapshot.') ? error : new NativeError('snapshot.capture-failed');
        if (signal?.aborted) throw new NativeError('snapshot.aborted');
      } finally {
        let failed = false;
        for (const handle of handles.values()) { try { files.close(handle); } catch { failed = true; } }
        if (failed) throw new NativeError('snapshot.cleanup');
      }
      if (attempt < 2) {
        try { await delay(50, undefined, signal ? { signal } : {}); }
        catch { throw new NativeError('snapshot.aborted'); }
      }
    }
    throw last;
  } finally { native?.[Symbol.dispose](); }
}
