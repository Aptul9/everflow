import { z } from 'zod';
import { cliJson } from './cli-json.ts';
import type { JsonQuery } from './cli-json.ts';
import { oeGoogleRead } from './oe-google.ts';
import type { OeGoogleRead } from './oe-google.ts';
import { oeEndpoint } from './oe-endpoint.ts';
import { httpOeCall } from './oemail.ts';
import { accountNames, emitChanged, isEntrypoint, publishAccounts, requiredOption, runSource, sourceStamp, sourceText, SourceError, watcherArguments, writeDiagnostic, writeRecord } from './source.ts';
import type { Emit, SourceMessage } from './source.ts';

const conversation = z.object({ id: z.string().min(1), name: z.string(), kind: z.enum(['dm', 'space']) });
const message = z.object({ id: z.string().min(1), thread: z.string().min(1), time: z.string().min(1), from_id: z.string().min(1), from: z.string(), text: z.string(),
  items: z.array(z.string()).optional(), edited: z.boolean().optional(), deleted: z.boolean().optional() });
const inventory = z.array(conversation).max(1000).nullable();
const response = z.object({ conversation, self_id: z.string().min(1), messages: z.array(message).max(100000).nullable() });
// The OE agent's Chat read: attachments and annotations as objects instead of gweb's lines.
const agentMessage = message.omit({ items: true }).extend({ attachments: z.array(z.object({ name: z.string(), mime_type: z.string() })).optional(),
  items: z.array(z.record(z.string(), z.unknown())).optional() });
const agentList = z.object({ self_id: z.string().min(1), conversations: z.array(conversation.extend({ last: z.string().optional() })).max(1000) });
const agentRead = z.object({ self_id: z.string().min(1), messages: z.array(agentMessage).max(100000) });

// Same lines gweb writes for annotations (internal/chat annotations), so both transports store the same text.
function gwebItems(raw: z.infer<typeof agentMessage>): string[] {
  const out = (raw.attachments ?? []).map((file) => `file: ${file.name} (${file.mime_type})`);
  for (const item of raw.items ?? []) {
    const url = (item.url as { url?: unknown } | undefined)?.url;
    if (typeof url === 'string') { if (url && !raw.text.includes(url)) out.push(`link: ${url}`); }
    else if (typeof item.id === 'string') out.push(`drive: ${String(item.title ?? '')} (${String(item.mimetype ?? '')}) id=${item.id}`);
  }
  return out;
}

// A Chat mention is the display name after @ in the message text.
function mentions(state: ReturnType<typeof createGchatState>, text: string): boolean {
  return !!state.selfName && text.toLowerCase().includes(`@${state.selfName.toLowerCase()}`);
}

// One record per returned message; items are gweb's annotation lines ("file: NAME (MIME)", "drive: ...", "link: URL").
function emitGchatMessage(state: ReturnType<typeof createGchatState>, item: z.infer<typeof conversation>, raw: z.infer<typeof message>, emit: Emit): void {
  const sent = sourceStamp(raw.time);
  if (Date.parse(sent) < Date.parse(state.floor)) return;
  const attachments = (raw.items ?? []).filter((item) => item.startsWith('file: ')).map((item) => ({ name: item.slice(6).replace(/ \([^)]*\)$/, '') || '(unnamed)' }));
  const record: SourceMessage = { source: 'gchat', account: state.account, conversation_id: item.id, conversation_title: item.name,
    message_id: `${item.id}/${raw.id}`, sender: raw.from_id, sender_name: raw.from, sender_is_me: raw.from_id === state.selfId, sent_at: sent,
    text: raw.deleted ? '' : sourceText([raw.text, ...(raw.items ?? []).filter((item) => !item.startsWith('file: '))].filter(Boolean).join('\n'), 50000),
    attachments: raw.deleted ? [] : attachments, ref: { account: state.account, space: item.id, id: raw.id, thread: raw.thread, edited: raw.edited ?? false,
      ...(raw.deleted ? { deleted: true } : {}), ...(!raw.deleted && raw.from_id !== state.selfId && mentions(state, raw.text) ? { mentions_me: true } : {}) } };
  if (state.seen.size >= 100000 && !state.seen.has(JSON.stringify(['gchat', state.account, record.message_id]))) throw new SourceError('gchat', 'gchat.message-limit');
  emitChanged(state.seen, record, emit);
}

export function createGchatState(options: { account: string; selfId: string; since: string; topics?: number; expectedAccounts?: string[]; browserRefresh?: boolean;
  fullSpaces?: string[]; selfName?: string }) {
  const account = accountNames([options.account])[0]!, topics = options.topics ?? 200;
  if (!account.includes('@') || !options.selfId || /[\s\0]/.test(options.selfId) || !Number.isSafeInteger(topics) || topics < 1 || topics > 1000) throw new SourceError('gchat', 'gchat.invalid-options');
  if (accountNames(options.expectedAccounts ?? []).some((name) => name !== account)) throw new SourceError('gchat', 'gchat.account-mismatch');
  return { account, selfId: options.selfId, topics, browserRefresh: options.browserRefresh === true, floor: sourceStamp(options.since), accounts: new Set<string>(), reported: '', seen: new Map<string, string>(),
    fullSpaces: new Set((options.fullSpaces ?? []).map((name) => name.trim().toLowerCase())), selfName: options.selfName?.trim() || '',
    kinds: new Map<string, ConversationKind>() };
}

// What a conversation is, from the agent's group detail: an app DM is never read; a DM with people and an unnamed group chat are
// read in full; a named space only for threads that tag Antonio or that he wrote in, unless it is listed in full_spaces.
type ConversationKind = 'app' | 'person' | 'group' | 'space';
const groupDetail = z.object({ group: z.looseObject({ group_type: z.string().optional(), name: z.string().optional() }) });

function kindOf(value: unknown, listed: z.infer<typeof conversation>): ConversationKind {
  const parsed = groupDetail.safeParse(value);
  if (!parsed.success) throw new SourceError('gchat', 'gchat.response-shape');
  const { group_type: type, name } = parsed.data.group;
  if (type === 'BOT_DM') return 'app';
  if (listed.kind === 'dm') return 'person';
  return name?.trim() ? 'space' : 'group';
}

// Messages of a named space that concern Antonio: every message of a thread with one of his messages or a mention of him.
function involved(state: ReturnType<typeof createGchatState>, messages: z.infer<typeof agentMessage>[]): z.infer<typeof agentMessage>[] {
  const threads = new Set(messages.filter((raw) => raw.from_id === state.selfId || mentions(state, raw.text)).map((raw) => raw.thread));
  return messages.filter((raw) => threads.has(raw.thread));
}

export async function scanGchat(query: JsonQuery, state: ReturnType<typeof createGchatState>, emit: Emit, now = () => new Date().toISOString(), signal?: AbortSignal): Promise<void> {
  const observed = sourceStamp(now());
  const refresh = state.browserRefresh ? '--background-refresh' : '--no-refresh';
  const listed = inventory.safeParse(await query(['chat', 'ls', '--json', refresh], signal));
  if (!listed.success) throw new SourceError('gchat', 'gchat.response-shape');
  const conversations = listed.data ?? [];
  if (new Set(conversations.map((item) => item.id)).size !== conversations.length) throw new SourceError('gchat', 'gchat.response-shape');
  publishAccounts('gchat', state, [state.account], emit);
  for (const item of conversations) {
    signal?.throwIfAborted();
    const parsed = response.safeParse(await query(['chat', 'read', item.id, '-n', String(state.topics), '--json', refresh], signal));
    if (!parsed.success || parsed.data.conversation.id !== item.id) throw new SourceError('gchat', 'gchat.response-shape');
    if (parsed.data.self_id !== state.selfId) throw new SourceError('gchat', 'gchat.account-mismatch');
    for (const raw of parsed.data.messages ?? []) emitGchatMessage(state, item, raw, emit);
  }
  // Topic and reply caps cannot establish a complete time cursor. Retain the replay floor.
  emit({ source: 'gchat', accounts: [state.account], checkpoint: state.floor, coverage: 'recent-topics', observed_at: observed });
}

// Through the OE agent: one list, then only the conversations with activity since the floor, several reads per SSH session.
export async function scanOeGchat(read: OeGoogleRead, state: ReturnType<typeof createGchatState>, emit: Emit, now = () => new Date().toISOString(), signal?: AbortSignal): Promise<void> {
  const observed = sourceStamp(now());
  const listed = agentList.safeParse((await read([{ action: 'list' }], signal))[0]);
  if (!listed.success) throw new SourceError('gchat', 'gchat.response-shape');
  if (listed.data.self_id !== state.selfId) throw new SourceError('gchat', 'gchat.account-mismatch');
  const conversations = listed.data.conversations;
  if (new Set(conversations.map((item) => item.id)).size !== conversations.length) throw new SourceError('gchat', 'gchat.response-shape');
  publishAccounts('gchat', state, [state.account], emit);
  const recent = conversations.filter((item) => !(Date.parse(item.last ?? '') < Date.parse(state.floor)));
  const unknown = recent.filter((item) => !state.kinds.has(item.id));
  (await read(unknown.map((item) => ({ action: 'group', conversation: item.id, kind: item.kind })), signal))
    .forEach((value, index) => state.kinds.set(unknown[index]!.id, kindOf(value, unknown[index]!)));
  const active = recent.filter((item) => state.kinds.get(item.id) !== 'app');
  const pages = await read(active.map((item) => ({ action: 'read', conversation: item.id, kind: item.kind, topics: state.topics })), signal);
  const parsedPages = pages.map((page) => {
    const parsed = agentRead.safeParse(page);
    if (!parsed.success) throw new SourceError('gchat', 'gchat.response-shape');
    if (parsed.data.self_id !== state.selfId) throw new SourceError('gchat', 'gchat.account-mismatch');
    return parsed.data.messages;
  });
  // Antonio's display name, for mentions, from his own messages when the configuration does not give it
  state.selfName ||= parsedPages.flat().find((raw) => raw.from_id === state.selfId && raw.from.trim())?.from.trim() ?? '';
  parsedPages.forEach((messages, index) => {
    const item = active[index]!;
    const full = state.kinds.get(item.id) !== 'space' || state.fullSpaces.has(item.name.toLowerCase()) || state.fullSpaces.has(item.id.toLowerCase());
    for (const raw of full ? messages : involved(state, messages)) emitGchatMessage(state, item, { ...raw, items: gwebItems(raw) }, emit);
  });
  emit({ source: 'gchat', accounts: [state.account], checkpoint: state.floor, coverage: 'recent-topics', observed_at: observed });
}

export async function gchatMain(args = process.argv.slice(2)): Promise<number> {
  const options = watcherArguments(args, { account: { type: 'string' }, 'self-id': { type: 'string' }, executable: { type: 'string' }, topics: { type: 'string' }, 'browser-refresh': { type: 'boolean' }, oe: { type: 'boolean' },
    'full-space': { type: 'string', multiple: true }, 'self-name': { type: 'string' } });
  const state = createGchatState({ account: requiredOption(options.values, 'account'), selfId: requiredOption(options.values, 'self-id'), since: new Date(Date.parse(options.since) - 120000).toISOString(),
    topics: options.values.topics === undefined ? 200 : Number(options.values.topics), expectedAccounts: options.expectedAccounts, browserRefresh: options.values['browser-refresh'] === true,
    fullSpaces: options.values['full-space'] ?? [], selfName: options.values['self-name'] });
  if (options.values.oe === true) {
    const read = oeGoogleRead(httpOeCall(oeEndpoint('gchat', 'oemail'), 'gchat'), 'gchat', state.account, 8);
    return runSource('gchat', options, (signal) => scanOeGchat(read, state, writeRecord, undefined, signal));
  }
  const executable = options.values.executable ?? 'gweb';
  return runSource('gchat', options, (signal) => scanGchat((args, stop) => cliJson('gchat', executable, args, stop, { timeoutMs: state.browserRefresh ? 240000 : 60000 }), state, writeRecord, undefined, signal));
}

if (isEntrypoint(import.meta.url)) void gchatMain().then((code) => { process.exitCode = code; }, (error: unknown) => { writeDiagnostic(error, 'gchat'); process.exitCode = 1; });
