import fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import type { ChatFile, ChatFileKind } from '../lib/web-types.ts';

// The files a ticket chat produced, read from disk for the page's viewer beside the chat: the daemon runs on the same
// machine and as the same user as OpenChamber. A file counts when the chat wrote or edited it, or named an existing
// Office document or PDF in its text or in a shell command or its output. Files it only read, and the vault's own
// bookkeeping (daily notes, the board, the tool-issue log), stay out.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PAGE = 200;
const MAX_PAGES = 200;
const MAX_SESSIONS = 20;

const failure = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });

const WRITERS = new Set(['write', 'edit', 'multiedit']);
const SHELLS = new Set(['shell', 'bash']);
// an absolute or home path ending in an Office or PDF extension, not the path part of a URL
const DOCUMENT = /(?<![\w./~:\\-])((?:~\/|\/)[^\s'"`<>|;*?()[\]{}]*?\.(?:docx|pdf|xlsx|pptx))(?!\w)/gi;
const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const TEXT = new Set(['.txt', '.log', '.csv', '.tsv', '.json', '.jsonc', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.xml', '.html', '.htm', '.svg',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.rb', '.php', '.sql', '.tf', '.tfvars', '.hcl', '.css', '.scss', '.vue', '.svelte', '.dart', '.swift', '.lua', '.pl', '.r', '.diff', '.patch']);
const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif' };
const DOWNLOAD: Record<string, string> = { ...IMAGE, '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };

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
  const place = (path: string) => path.startsWith('~/') ? join(home, path.slice(2)) : resolve(directory, path);
  const documents = (text: string, at: number) => { for (const match of text.matchAll(DOCUMENT)) found.push([place(match[1]!), at]); };
  for (const value of message.content) {
    const part = record(value);
    if (part?.type === 'text' && typeof part.text === 'string') { documents(part.text, created); continue; }
    if (part?.type !== 'tool' || typeof part.name !== 'string') continue;
    const state = record(part.state), input = record(state?.input);
    if (state?.status !== 'completed' || !input) continue;
    const at = millis(record(part.time)?.completed, record(part.time)?.created, created);
    if (WRITERS.has(part.name)) {
      const path = [input.path, input.filePath, input.file_path].find((candidate): candidate is string => typeof candidate === 'string' && !!candidate);
      if (path) found.push([place(path), at]);
    } else if (SHELLS.has(part.name)) {
      for (const text of [...texts(input.command), ...texts(state.content), ...texts(state.output), ...texts(record(state.metadata)?.output)]) documents(text, at);
    }
  }
  return found;
}

function kindOf(path: string): ChatFileKind {
  const ext = extname(path).toLowerCase();
  if (MARKDOWN.has(ext)) return 'markdown';
  if (TEXT.has(ext)) return 'text';
  if (ext === '.docx') return 'docx';
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

/** Word document as HTML safe to put in the page: structure, tables, links to http(s)/mailto, images only as data: URIs. */
export function sanitize(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'span', 'a', 'img'],
    allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], ol: ['start'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    // every link opens a new tab without the page as opener, whatever the document said
    transformTags: { a: (tagName, attribs) => ({ tagName, attribs: { ...(attribs.href ? { href: attribs.href } : {}), target: '_blank', rel: 'noopener noreferrer' } }) },
    exclusiveFilter: (frame) => frame.tag === 'img' && !/^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i.test(frame.attribs.src ?? ''),
  });
}

export async function docxHtml(buffer: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer }, { externalFileAccess: false });
  return sanitize(result.value);
}

export interface FileContent { body: Buffer | string; type: string; name: string; download: boolean }
interface History { get(path: string): Promise<unknown> }
interface Seen { directory: string; items: Map<string, [string, number][]>; pending?: Promise<void> | undefined }

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
          current.items.set(id, mentions(item, current.directory, this.home));
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
    const seen = await this.load(session);
    const latest = new Map<string, number>();
    for (const found of seen.items.values()) for (const [path, at] of found) if (!housekeeping(path)) latest.set(path, Math.max(latest.get(path) ?? 0, at));
    const files = new Map<string, ChatFile & { at: number }>();
    for (const [path, at] of latest) {
      const real = this.inside(path);
      if (!real || housekeeping(real)) continue;
      const known = files.get(real);
      if (known && known.at >= at) continue;
      const stat = fs.statSync(real);
      files.set(real, { path, name: basename(path), size: stat.size, mtime: stat.mtime.toISOString(), kind: kindOf(real), touched: new Date(at).toISOString(), at });
    }
    return [...files.values()].sort((a, b) => b.at - a.at || Date.parse(b.mtime) - Date.parse(a.mtime)).map(({ at: _at, ...file }) => file);
  }

  /** One listed file: text as is, a Word document as sanitized HTML, PDFs and images as bytes; download gives the bytes of any. */
  async read(session: string, path: string, download = false): Promise<FileContent> {
    const listed = (await this.list(session)).find((file) => file.path === path);
    if (!listed) throw failure(404, 'file.not-listed', 'This chat has not written that file');
    const real = this.inside(path);
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
      case 'docx': return { body: await docxHtml(buffer).catch(() => { throw failure(422, 'file.unreadable', `${name} could not be read as a Word document`); }),
        type: 'text/html; charset=utf-8', name, download: false };
      case 'pdf': case 'image': return { body: buffer, type: DOWNLOAD[ext]!, name, download: false };
      default: throw failure(415, 'file.download-only', `${name} can only be downloaded`);
    }
  }
}
