import fs from 'node:fs';
import { basename, isAbsolute, join, parse, resolve } from 'node:path';

export const VAULT_LIMITS = {
  hits: 50, noteBytes: 32_768, entries: 2_048, files: 256, searchBytes: 1_048_576, depth: 16, queryChars: 256, snippetChars: 240,
} as const;

export interface Note { path: string; title: string; text: string; truncated: boolean }
export interface SearchHit { path: string; title: string; line: number; snippet: string }

export class VaultError extends Error {}

function excluded(name: string): boolean {
  return name.toLowerCase() === '_secrets' || name.toLowerCase().startsWith('.unison.');
}

function safeComponent(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' && !/[. ]$/.test(name)
    && !/[\x00-\x1f<>:"|?*%\\/]/.test(name) && !excluded(name)
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
}

export function isNotePath(value: string): boolean {
  return typeof value === 'string' && value.length <= 1_024 && value.normalize('NFKC') === value
    && /\.md$/i.test(value) && value.split('/').every(safeComponent);
}

function numericLimit(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`Limit must be an integer from 1 to ${maximum}`);
}

function expandedComponent(path: string): void {
  let name: string;
  try { name = basename(fs.realpathSync.native(path)); }
  catch { throw new VaultError('Vault path is missing or inaccessible'); }
  if (!safeComponent(name) || name.normalize('NFKC') !== name) throw new VaultError('Unsafe expanded vault path component');
}

function directory(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new VaultError('Vault root must be an absolute directory');
  const { root } = parse(path);
  const parts = path.slice(root.length).split(/[\\/]/);
  if (parts.some((part) => !safeComponent(part))) throw new VaultError('Unsafe vault root path');
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch { throw new VaultError('Vault root or path is missing or inaccessible'); }
    if (stat.isSymbolicLink()) throw new VaultError('Vault root and path components must not be links');
    if (!stat.isDirectory()) throw new VaultError('Vault root and path components must be directories');
    if (part) expandedComponent(current);
  }
  return resolve(path);
}

function checkedFile(root: string, path: string): { absolute: string; stat: fs.Stats } {
  if (!isNotePath(path)) throw new VaultError('Unsafe relative Markdown note path');
  const parts = path.split('/');
  let current = directory(root);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch { throw new VaultError('Note or path is missing or inaccessible'); }
    if (stat.isSymbolicLink()) throw new VaultError('Note path must not contain links');
    expandedComponent(current);
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw new VaultError('Note path component is not a directory');
    } else {
      if (!stat.isFile() || stat.nlink > 1) throw new VaultError('Note must be a regular, unlinked file');
      return { absolute: current, stat };
    }
  }
  throw new VaultError('Missing note path');
}

function readNote(root: string, relativePath: string, cap: number, consumed: (bytes: number) => void): Note {
  numericLimit(cap, VAULT_LIMITS.noteBytes);
  const { absolute, stat } = checkedFile(root, relativePath);
  let fd: number;
  try { fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch { throw new VaultError('Note is missing, linked or inaccessible'); }
  try {
    const opened = fs.fstatSync(fd);
    const rechecked = checkedFile(root, relativePath).stat;
    if (!opened.isFile() || opened.nlink > 1 || opened.dev !== stat.dev || opened.ino !== stat.ino
      || opened.dev !== rechecked.dev || opened.ino !== rechecked.ino) throw new VaultError('Note path changed during open');
    const buffer = Buffer.alloc(Math.min(opened.size, cap));
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
      consumed(count);
    }
    const truncated = opened.size > length;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length), { stream: truncated }); }
    catch { throw new VaultError('Note is binary or invalid UTF-8'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new VaultError('Note is binary or invalid UTF-8');
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? basename(relativePath, '.md');
    return { path: relativePath, title: title.slice(0, VAULT_LIMITS.snippetChars), text, truncated };
  } finally { fs.closeSync(fd); }
}

export function vaultRead(root: string, relativePath: string, cap = 16_384): Note {
  return readNote(root, relativePath, cap, () => {});
}

export function vaultSearch(root: string, query: string, limit = 10): SearchHit[] {
  numericLimit(limit, VAULT_LIMITS.hits);
  if (typeof query !== 'string' || !query.trim() || query.length > VAULT_LIMITS.queryChars) throw new TypeError('Query must contain 1 to 256 characters');
  const base = directory(root);
  const hits: SearchHit[] = [];
  const pending = [{ path: '', depth: 0 }];
  const needle = query.toLowerCase();
  let entries = 0;
  let files = 0;
  let bytes = VAULT_LIMITS.searchBytes as number;
  while (pending.length && entries < VAULT_LIMITS.entries && files < VAULT_LIMITS.files && bytes > 0 && hits.length < limit) {
    const next = pending.pop()!;
    let dir: fs.Dir;
    try { dir = fs.opendirSync(directory(next.path ? join(base, next.path) : base)); }
    catch (error) { if (error instanceof VaultError) continue; throw error; }
    try {
      let entry: fs.Dirent | null;
      while (entries < VAULT_LIMITS.entries && files < VAULT_LIMITS.files && bytes > 0 && hits.length < limit && (entry = dir.readSync())) {
        entries++;
        if (!safeComponent(entry.name) || entry.isSymbolicLink()) continue;
        const path = next.path ? `${next.path}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (next.depth < VAULT_LIMITS.depth) pending.push({ path, depth: next.depth + 1 });
          continue;
        }
        if (!entry.isFile() || !isNotePath(path)) continue;
        files++;
        const cap = Math.min(bytes, VAULT_LIMITS.noteBytes);
        let note: Note;
        try { note = readNote(base, path, cap, (count) => { bytes -= count; }); }
        catch (error) { if (error instanceof VaultError) continue; throw error; }
        const lines = note.text.split(/\r?\n/);
        const index = lines.findIndex((line) => line.toLowerCase().includes(needle));
        if (index >= 0) hits.push({ path, title: note.title, line: index + 1, snippet: lines[index]!.slice(0, VAULT_LIMITS.snippetChars) });
      }
    } finally { dir.closeSync(); }
  }
  return hits;
}
