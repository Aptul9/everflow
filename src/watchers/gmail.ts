import { z } from 'zod';
import { cliJson } from './cli-json.ts';
import type { JsonQuery } from './cli-json.ts';
import { accountNames, emitChanged, isEntrypoint, publishAccounts, requiredOption, runSource, sourceStamp, sourceText, SourceError, watcherArguments, writeDiagnostic, writeRecord } from './source.ts';
import type { Emit, SourceMessage } from './source.ts';
import { htmlToText } from './teams.ts';

const id = z.string().min(1);
const pageSchema = z.object({ messages: z.array(z.object({ id, threadId: id })).max(500).optional(), nextPageToken: id.optional() });
const mailSchema = z.object({ id, threadId: id, internalDate: z.string().regex(/^\d+$/), labelIds: z.array(z.string()), payload: z.record(z.string(), z.unknown()) });
const profileSchema = z.object({ emailAddress: z.email() });

function mime(payload: Record<string, any>, depth = 0): { text: string; attachments: SourceMessage['attachments'] } {
  if (depth > 32 || typeof payload.mimeType !== 'string') throw new SourceError('gmail', 'gmail.mime-shape');
  if (payload.filename) {
    if (typeof payload.filename !== 'string' || !Number.isSafeInteger(payload.body?.size) || payload.body.size < 0) throw new SourceError('gmail', 'gmail.mime-shape');
    return { text: '', attachments: [{ name: payload.filename, size: payload.body.size }] };
  }
  if (payload.parts !== undefined) {
    if (!Array.isArray(payload.parts) || payload.parts.length > 1000) throw new SourceError('gmail', 'gmail.mime-shape');
    const parts = payload.parts.map((part: unknown) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) throw new SourceError('gmail', 'gmail.mime-shape');
      return { raw: part as Record<string, any>, value: mime(part, depth + 1) };
    });
    const texts = payload.mimeType === 'multipart/alternative' ? [parts.find((part) => part.raw.mimeType === 'text/plain' && part.value.text) ?? parts.find((part) => part.value.text)].filter((part) => part !== undefined)
      : parts;
    return { text: texts.map((part) => part.value.text).filter(Boolean).join('\n'), attachments: parts.flatMap((part) => part.value.attachments) };
  }
  if (!['text/plain', 'text/html'].includes(payload.mimeType)) return { text: '', attachments: [] };
  if (payload.body?.attachmentId && payload.body.data === undefined) throw new SourceError('gmail', 'gmail.body-unavailable');
  const data = payload.body?.data ?? '';
  if (typeof data !== 'string' || !/^[a-zA-Z0-9_-]*={0,2}$/.test(data)) throw new SourceError('gmail', 'gmail.mime-shape');
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  const contentType = headers.find((header: any) => String(header.name).toLowerCase() === 'content-type')?.value ?? '';
  const charset = /charset\s*=\s*"?([^\s;"']+)/i.exec(String(contentType))?.[1] ?? 'utf-8';
  let text: string;
  try { text = new TextDecoder(charset, { fatal: true }).decode(Buffer.from(data, 'base64url')); }
  catch { throw new SourceError('gmail', 'gmail.mime-encoding'); }
  if (payload.mimeType === 'text/html') text = htmlToText(text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ''));
  return { text: sourceText(text, 50000), attachments: [] };
}

function normalize(value: unknown, account: string, expected: { id: string; threadId: string }): SourceMessage {
  const result = mailSchema.safeParse(value);
  if (!result.success) throw new SourceError('gmail', 'gmail.response-shape');
  const raw = result.data;
  if (raw.id !== expected.id || raw.threadId !== expected.threadId) throw new SourceError('gmail', 'gmail.response-shape');
  const headers = z.array(z.object({ name: z.string(), value: z.string() })).safeParse(raw.payload.headers);
  if (!headers.success) throw new SourceError('gmail', 'gmail.response-shape');
  const header = (name: string) => headers.data.find((header) => header.name.toLowerCase() === name)?.value ?? '';
  const from = header('from'), sender = (/<([^<>]+@[^<>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  const parsed = mime(raw.payload);
  const time = Number(raw.internalDate);
  if (!Number.isSafeInteger(time) || !Number.isFinite(new Date(time).getTime())) throw new SourceError('gmail', 'gmail.message-time');
  return { source: 'gmail', account, conversation_id: raw.threadId, conversation_title: header('subject'), message_id: raw.id,
    sender, sender_name: from.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, ''), sender_is_me: raw.labelIds.includes('SENT') || sender === account,
    sent_at: new Date(time).toISOString(), text: sourceText(parsed.text, 50000), attachments: parsed.attachments,
    ref: { account, id: raw.id, thread: raw.threadId, message_id: header('message-id') } };
}

export function createGmailState(options: { account: string; since: string; expectedAccounts?: string[] }) {
  const account = accountNames([options.account])[0]!;
  if (!account.includes('@') || accountNames(options.expectedAccounts ?? []).some((name) => name !== account)) throw new SourceError('gmail', 'gmail.account-mismatch');
  return { account, floor: sourceStamp(options.since), accounts: new Set<string>(), reported: '', seen: new Map<string, string>() };
}

export async function scanGmail(query: JsonQuery, state: ReturnType<typeof createGmailState>, emit: Emit, now = () => new Date().toISOString(), signal?: AbortSignal): Promise<void> {
  const started = sourceStamp(now());
  const command = (path: string[], params: Record<string, unknown>) => query(['gmail', 'users', ...path, '--params', JSON.stringify({ userId: 'me', ...params }), '--format', 'json'], signal);
  const profile = profileSchema.safeParse(await command(['getProfile'], {}));
  if (!profile.success || profile.data.emailAddress.toLowerCase() !== state.account) throw new SourceError('gmail', 'gmail.account-mismatch');
  publishAccounts('gmail', state, [state.account], emit);
  const q = `{in:inbox in:sent} after:${Math.floor(Date.parse(state.floor) / 1000) - 120}`;
  const tokens = new Set<string>(), ids = new Set<string>();
  let pageToken: string | undefined;
  for (let pages = 0; ; pages++) {
    signal?.throwIfAborted();
    if (pages >= 100) throw new SourceError('gmail', 'gmail.pagination-limit');
    const parsed = pageSchema.safeParse(await command(['messages', 'list'], { q, maxResults: 500, ...(pageToken ? { pageToken } : {}) }));
    if (!parsed.success) throw new SourceError('gmail', 'gmail.response-shape');
    for (const item of parsed.data.messages ?? []) {
      if (ids.has(item.id)) continue;
      ids.add(item.id);
      const record = normalize(await command(['messages', 'get'], { id: item.id, format: 'full' }), state.account, item);
      if (record.sent_at < new Date(Date.parse(state.floor) - 120000).toISOString()) continue;
      if (state.seen.size >= 100000 && !state.seen.has(JSON.stringify(['gmail', state.account, record.message_id]))) throw new SourceError('gmail', 'gmail.message-limit');
      emitChanged(state.seen, record, emit);
    }
    pageToken = parsed.data.nextPageToken;
    if (!pageToken) break;
    if (tokens.has(pageToken)) throw new SourceError('gmail', 'gmail.pagination-limit');
    tokens.add(pageToken);
  }
  emit({ source: 'gmail', accounts: [state.account], checkpoint: started });
  state.floor = started;
}

export async function gmailMain(args = process.argv.slice(2)): Promise<number> {
  const options = watcherArguments(args, { account: { type: 'string' }, executable: { type: 'string' } });
  const state = createGmailState({ account: requiredOption(options.values, 'account'), since: options.since, expectedAccounts: options.expectedAccounts });
  const executable = options.values.executable ?? 'gws';
  return runSource('gmail', options, (signal) => scanGmail((args, stop) => cliJson('gmail', executable, args, stop), state, writeRecord, undefined, signal));
}

if (isEntrypoint(import.meta.url)) void gmailMain().then((code) => { process.exitCode = code; }, (error: unknown) => { writeDiagnostic(error, 'gmail'); process.exitCode = 1; });
