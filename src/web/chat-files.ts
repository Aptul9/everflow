import fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ChatFile, ChatFileKind } from '../lib/web-types.ts';

// The files a ticket chat produced, read from disk for the page's viewer beside the chat: the daemon runs on the same
// machine and as the same user as OpenChamber. A file counts when the chat wrote or edited it, or named an existing
// Office document or PDF in its text or in a shell command or its output. Files it only read, and the vault's own
// bookkeeping (daily notes, the board, the tool-issue log), stay out of that list. A file clicked in the chat opens too when
// the history names it anywhere, read-only files included (describe).
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PAGE = 200;
const MAX_PAGES = 200;
const MAX_SESSIONS = 20;

const failure = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });

const WRITERS = new Set(['write', 'edit', 'multiedit']);
const SHELLS = new Set(['shell', 'bash']);
// an absolute or home path ending in an Office or PDF extension, not the path part of a URL
const DOCUMENT = /(?<![\w./~:\\-])((?:~\/|\/)[^\s'"`<>|;*?()[\]{}]*?\.(?:docx|pdf|xlsx|xls|pptx|ods|odt|odp))(?!\w)/gi;
const QUOTED_DOCUMENT = /(?:`((?:~\/|\/)[^\r\n`]+)`|"((?:~\/|\/)[^\r\n"]+)"|'((?:~\/|\/)[^\r\n']+)')/g;
const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const TEXT = new Set(['.txt', '.log', '.csv', '.tsv', '.json', '.jsonc', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.xml', '.html', '.htm', '.svg',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.rb', '.php', '.sql', '.tf', '.tfvars', '.hcl', '.css', '.scss', '.vue', '.svelte', '.dart', '.swift', '.lua', '.pl', '.r', '.diff', '.patch']);
const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif' };
const DOWNLOAD: Record<string, string> = { ...IMAGE, '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel', '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odt': 'application/vnd.oasis.opendocument.text', '.odp': 'application/vnd.oasis.opendocument.presentation' };

function quotedDocuments(text: string): string[] {
  return [...text.matchAll(QUOTED_DOCUMENT)].flatMap(([, code, double, single]) => {
    const path = code ?? double ?? single;
    const extension = path && extname(path).toLowerCase();
    return path && extension && Object.hasOwn(DOWNLOAD, extension) && !Object.hasOwn(IMAGE, extension) ? [path] : [];
  });
}

export function housekeeping(path: string): boolean {
  const posix = path.replaceAll('\\', '/');
  return posix.includes('/05_Daily/') || posix.endsWith('/01_Projects/Board.md') || posix.endsWith('/99_Inbox/everflow-tool-issues.md');
}

type Fields = Record<string, unknown>;
const record = (value: unknown): Fields | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : null;
const millis = (...values: unknown[]) => values.find((value): value is number => typeof value === 'number' && Number.isFinite(value)) ?? 0;

function texts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => { const text = record(part)?.text; return typeof text === 'string' ? [text] : []; });
}

/**
 * Paths one history item points at, with when: write and edit targets as given (relative to the session folder), and
 * documents named in assistant text or shell commands and output. Existence and housekeeping are checked later.
 */
export function mentions(item: unknown, directory: string, home: string): [string, number][] {
  const message = record(item);
  if (message?.type !== 'assistant' || !Array.isArray(message.content)) return [];
  const created = millis(record(message.time)?.completed, record(message.time)?.created);
  const found: [string, number][] = [];
  const documents = (text: string, at: number) => {
    const paths = new Set([...text.matchAll(DOCUMENT)].map((match) => match[1]!));
    for (const path of quotedDocuments(text)) paths.add(path);
    for (const path of paths) found.push([place(path, directory, home), at]);
  };
  for (const value of message.content) {
    const part = record(value);
    if (part?.type === 'text' && typeof part.text === 'string') { documents(part.text, created); continue; }
    if (part?.type !== 'tool' || typeof part.name !== 'string') continue;
    const state = record(part.state), input = record(state?.input);
    if (state?.status !== 'completed' || !input) continue;
    const at = millis(record(part.time)?.completed, record(part.time)?.created, created);
    if (WRITERS.has(part.name)) {
      const path = [input.path, input.filePath, input.file_path].find((candidate): candidate is string => typeof candidate === 'string' && !!candidate);
      if (path) found.push([place(path, directory, home), at]);
    } else if (SHELLS.has(part.name)) {
      for (const text of [...texts(input.command), ...texts(state.content), ...texts(state.output), ...texts(record(state.metadata)?.output)]) documents(text, at);
    }
  }
  return found;
}

const PATH_KEYS = new Set(['path', 'filePath', 'file_path']);
// a word of text that may name a file: what OpenChamber turns into a link, minus quotes, brackets and trailing punctuation
const WORD = /[^\s'"`<>|;*?()[\]{},]+/g;

function pathWords(text: string): string[] {
  const found = new Set(quotedDocuments(text));
  for (const [raw] of text.matchAll(WORD)) {
    const word = raw.replace(/[.:!]+$/, '').replace(/(?::\d+){1,2}$/, '');
    if (!word || word.startsWith('//') || /^[a-z][\w+.-]*:/i.test(word)) continue;
    if (word.startsWith('/') || word.startsWith('~/') || word.includes('/') || /\.\w{1,10}$/.test(word)) found.add(word);
  }
  return [...found];
}

function strings(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (depth > 4 || !value || typeof value !== 'object') return [];
  return Object.values(value).flatMap((inner) => strings(inner, depth + 1));
}

/**
 * Every path one history item names, with when, for a click in the chat: any tool's path input (reads included), and
 * path-like words in message text and in other tool inputs such as shell commands. Relative paths are taken from the
 * session folder. Whether the file exists and where it really lives is checked when it is opened.
 */
export function references(item: unknown, directory: string, home: string): [string, number][] {
  const message = record(item);
  if (!message) return [];
  const created = millis(record(message.time)?.completed, record(message.time)?.created);
  const found: [string, number][] = [];
  const add = (path: string, at: number) => { if (path.length <= 4096) found.push([place(path, directory, home), at]); };
  for (const text of texts(message.text)) for (const word of pathWords(text)) add(word, created);
  for (const value of Array.isArray(message.content) ? message.content : []) {
    const part = record(value);
    if (part?.type === 'text' && typeof part.text === 'string') { for (const word of pathWords(part.text)) add(word, created); continue; }
    if (part?.type !== 'tool') continue;
    const input = record(record(part.state)?.input);
    if (!input) continue;
    const at = millis(record(part.time)?.completed, record(part.time)?.created, created);
    for (const [key, field] of Object.entries(input)) {
      if (PATH_KEYS.has(key) && typeof field === 'string' && field.trim()) add(field.trim(), at);
      else for (const text of strings(field)) for (const word of pathWords(text)) add(word, at);
    }
  }
  return found;
}

/** A path as the chat spelled it, made absolute: home-relative from the home folder, relative from the session folder. */
export function place(path: string, directory: string, home: string): string {
  return path.startsWith('~/') ? join(home, path.slice(2)) : resolve(directory, path);
}

function kindOf(path: string): ChatFileKind {
  const ext = extname(path).toLowerCase();
  if (MARKDOWN.has(ext)) return 'markdown';
  if (TEXT.has(ext)) return 'text';
  if (ext === '.docx') return 'docx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.odt') return 'odt';
  if (ext === '.odp') return 'odp';
  if (ext === '.xlsx' || ext === '.xls' || ext === '.ods') return 'workbook';
  if (ext === '.pdf') return 'pdf';
  if (IMAGE[ext]) return 'image';
  if (DOWNLOAD[ext]) return 'other';
  // no or an unknown extension: text when the first 8 KB hold no NUL and decode as UTF-8
  try {
    const fd = fs.openSync(path, 'r');
    try {
      const head = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, head, 0, head.length, 0);
      if (head.subarray(0, bytes).includes(0)) return 'other';
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, bytes), { stream: true });
      return 'text';
    } finally { fs.closeSync(fd); }
  } catch { return 'other'; }
}

export interface FileContent { body: Buffer | string; type: string; name: string; download: boolean }
interface History { get(path: string): Promise<unknown> }
interface Item { found: [string, number][]; named: [string, number][] }
interface Seen { directory: string; items: Map<string, Item>; pending?: Promise<void> | undefined }

export class ChatFiles {
  private readonly chat: History;
  private readonly home: string;
  // per session, what each history item points at: a later listing reads only the newest pages
  private readonly sessions = new Map<string, Seen>();
  constructor(chat: History, home = homedir()) { this.chat = chat; this.home = home; }

  /** The real path when it is a regular file inside the home folder (symlinks followed), else null. */
  inside(path: string): string | null {
    try {
      const real = fs.realpathSync(path), home = fs.realpathSync(this.home);
      const rest = relative(home, real);
      if (!rest || rest.startsWith('..') || isAbsolute(rest)) return null;
      return fs.statSync(real).isFile() ? real : null;
    } catch { return null; }
  }

  private async load(session: string): Promise<Seen> {
    let seen = this.sessions.get(session);
    if (!seen) {
      const found = record(record(record(await this.chat.get(`/api/session/${encodeURIComponent(session)}`))?.data)?.location)?.directory;
      if (typeof found !== 'string' || !found) throw failure(502, 'chat.unavailable', `OpenChamber gave no folder for session ${session}`);
      seen = { directory: found, items: new Map() };
      this.sessions.set(session, seen);
      if (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    }
    const current = seen;
    // newest first; a page whose items were all seen before ends the walk, since only recent items still change
    current.pending ??= (async () => {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ directory: current.directory, limit: String(PAGE), ...(cursor ? { cursor } : {}) });
        const result = record(await this.chat.get(`/api/session/${encodeURIComponent(session)}/message?${query}`));
        const data = Array.isArray(result?.data) ? result.data : [];
        let fresh = false;
        for (const item of data) {
          const id = record(item)?.id;
          if (typeof id !== 'string') continue;
          if (!current.items.has(id)) fresh = true;
          current.items.set(id, { found: mentions(item, current.directory, this.home), named: references(item, current.directory, this.home) });
        }
        const next = record(result?.cursor)?.next;
        if (!fresh || !data.length || typeof next !== 'string' || !next) break;
        cursor = next;
      }
    })().finally(() => { current.pending = undefined; });
    await current.pending;
    return current;
  }

  /** Newest first: by when the chat last touched the file, then by the file's own change time. */
  async list(session: string): Promise<ChatFile[]> {
    return this.listed(await this.load(session));
  }

  private entry(path: string, real: string, at: number): ChatFile & { at: number } {
    const stat = fs.statSync(real);
    return { path, name: basename(path), size: stat.size, mtime: stat.mtime.toISOString(), kind: kindOf(real), touched: new Date(at).toISOString(), at };
  }

  private listed(seen: Seen): ChatFile[] {
    const latest = new Map<string, number>();
    for (const { found } of seen.items.values()) for (const [path, at] of found) if (!housekeeping(path)) latest.set(path, Math.max(latest.get(path) ?? 0, at));
    const files = new Map<string, ChatFile & { at: number }>();
    for (const [path, at] of latest) {
      const real = this.inside(path);
      if (!real || housekeeping(real)) continue;
      const known = files.get(real);
      if (known && known.at >= at) continue;
      files.set(real, this.entry(path, real, at));
    }
    return [...files.values()].sort((a, b) => b.at - a.at || Date.parse(b.mtime) - Date.parse(a.mtime)).map(({ at: _at, ...file }) => file);
  }

  /**
   * A file the chat can open: one of the listed files, or any other file its history names (a file it only read, a path in
   * its text or in a command), the latter as clicked in the chat, absolute or relative to the session folder. Either way
   * a regular file inside the home folder once links are followed.
   */
  async describe(session: string, path: string): Promise<ChatFile> {
    const seen = await this.load(session);
    const unnamed = () => failure(404, 'file.not-listed', 'This chat has not named that file');
    // an absolute path is taken only as written, never through .. or doubled separators
    if (!path || path.length > 4096 || path.includes('\0') || isAbsolute(path) && resolve(path) !== path) throw unnamed();
    const target = place(path, seen.directory, this.home);
    const real = this.inside(target);
    const listed = this.listed(seen).find((file) => file.path === path || file.path === target || !!real && this.inside(file.path) === real);
    if (listed) return listed;
    let at = -1;
    const name = basename(target);
    for (const { named } of seen.items.values()) {
      for (const [candidate, when] of named) {
        if (when > at && (candidate === target || !!real && basename(candidate) === name && this.inside(candidate) === real)) at = when;
      }
    }
    if (at < 0) throw unnamed();
    if (!real) throw fs.existsSync(target) ? failure(403, 'file.outside', 'Only regular files inside the home folder open here') : failure(404, 'file.missing', `${name} does not exist`);
    const { at: _at, ...file } = this.entry(target, real, at);
    return file;
  }

  /** One file the chat can open: text as is, documents and images as bytes; download gives the bytes of any. */
  async read(session: string, path: string, download = false): Promise<FileContent> {
    const listed = await this.describe(session, path);
    const real = this.inside(listed.path);
    if (!real) throw failure(403, 'file.outside', 'Only regular files inside the home folder open here');
    const fd = fs.openSync(real, 'r');
    let buffer: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw failure(403, 'file.outside', 'Only regular files inside the home folder open here');
      if (stat.size > MAX_FILE_BYTES) throw failure(413, 'file.too-large', `${listed.name} is larger than 10 MB`);
      buffer = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    if (buffer.length > MAX_FILE_BYTES) throw failure(413, 'file.too-large', `${listed.name} is larger than 10 MB`);
    const ext = extname(real).toLowerCase(), name = listed.name;
    if (download) return { body: buffer, type: DOWNLOAD[ext] ?? 'application/octet-stream', name, download: true };
    switch (listed.kind) {
      case 'markdown': return { body: buffer.toString('utf8'), type: 'text/markdown; charset=utf-8', name, download: false };
      case 'text': return { body: buffer.toString('utf8'), type: 'text/plain; charset=utf-8', name, download: false };
      case 'pdf': case 'image': case 'docx': case 'pptx': case 'odt': case 'odp': case 'workbook':
        return { body: buffer, type: DOWNLOAD[ext]!, name, download: false };
      default: throw failure(415, 'file.download-only', `${name} can only be downloaded`);
    }
  }
}
