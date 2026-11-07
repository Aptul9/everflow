import { z } from 'zod';
import { cliJson } from './cli-json.ts';
import type { JsonQuery } from './cli-json.ts';
import { accountNames, emitChanged, isEntrypoint, publishAccounts, requiredOption, runSource, sourceStamp, sourceText, SourceError, watcherArguments, writeDiagnostic, writeRecord } from './source.ts';
import type { Emit, SourceMessage } from './source.ts';

const conversation = z.object({ id: z.string().min(1), name: z.string(), kind: z.enum(['dm', 'space']) });
const message = z.object({ id: z.string().min(1), thread: z.string().min(1), time: z.string().min(1), from_id: z.string().min(1), from: z.string(), text: z.string(),
  items: z.array(z.string()).optional(), edited: z.boolean().optional(), deleted: z.boolean().optional() });
const inventory = z.array(conversation).max(1000).nullable();
const response = z.object({ conversation, self_id: z.string().min(1), messages: z.array(message).max(100000).nullable() });

export function createGchatState(options: { account: string; selfId: string; since: string; topics?: number; expectedAccounts?: string[]; browserRefresh?: boolean }) {
  const account = accountNames([options.account])[0]!, topics = options.topics ?? 200;
  if (!account.includes('@') || !options.selfId || /[\s\0]/.test(options.selfId) || !Number.isSafeInteger(topics) || topics < 1 || topics > 1000) throw new SourceError('gchat', 'gchat.invalid-options');
  if (accountNames(options.expectedAccounts ?? []).some((name) => name !== account)) throw new SourceError('gchat', 'gchat.account-mismatch');
  return { account, selfId: options.selfId, topics, browserRefresh: options.browserRefresh === true, floor: sourceStamp(options.since), accounts: new Set<string>(), reported: '', seen: new Map<string, string>() };
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
    for (const raw of parsed.data.messages ?? []) {
      const sent = sourceStamp(raw.time);
      if (Date.parse(sent) < Date.parse(state.floor)) continue;
      const attachments = (raw.items ?? []).filter((item) => item.startsWith('file: ')).map((item) => ({ name: item.slice(6).replace(/ \([^)]*\)$/, '') || '(unnamed)' }));
      const record: SourceMessage = { source: 'gchat', account: state.account, conversation_id: item.id, conversation_title: item.name,
        message_id: `${item.id}/${raw.id}`, sender: raw.from_id, sender_name: raw.from, sender_is_me: raw.from_id === state.selfId, sent_at: sent,
        text: raw.deleted ? '' : sourceText([raw.text, ...(raw.items ?? []).filter((item) => !item.startsWith('file: '))].filter(Boolean).join('\n'), 50000),
        attachments: raw.deleted ? [] : attachments, ref: { account: state.account, space: item.id, id: raw.id, thread: raw.thread, edited: raw.edited ?? false, ...(raw.deleted ? { deleted: true } : {}) } };
      if (state.seen.size >= 100000 && !state.seen.has(JSON.stringify(['gchat', state.account, record.message_id]))) throw new SourceError('gchat', 'gchat.message-limit');
      emitChanged(state.seen, record, emit);
    }
  }
  // Topic and reply caps cannot establish a complete time cursor. Retain the replay floor.
  emit({ source: 'gchat', accounts: [state.account], checkpoint: state.floor, coverage: 'recent-topics', observed_at: observed });
}

export async function gchatMain(args = process.argv.slice(2)): Promise<number> {
  const options = watcherArguments(args, { account: { type: 'string' }, 'self-id': { type: 'string' }, executable: { type: 'string' }, topics: { type: 'string' }, 'browser-refresh': { type: 'boolean' } });
  const state = createGchatState({ account: requiredOption(options.values, 'account'), selfId: requiredOption(options.values, 'self-id'), since: new Date(Date.parse(options.since) - 120000).toISOString(),
    topics: options.values.topics === undefined ? 200 : Number(options.values.topics), expectedAccounts: options.expectedAccounts, browserRefresh: options.values['browser-refresh'] === true });
  const executable = options.values.executable ?? 'gweb';
  return runSource('gchat', options, (signal) => scanGchat((args, stop) => cliJson('gchat', executable, args, stop, { timeoutMs: state.browserRefresh ? 240000 : 60000 }), state, writeRecord, undefined, signal));
}

if (isEntrypoint(import.meta.url)) void gchatMain().then((code) => { process.exitCode = code; }, (error: unknown) => { writeDiagnostic(error, 'gchat'); process.exitCode = 1; });
