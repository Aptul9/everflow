import { z } from 'zod';
import { parseOeOutput } from './oemail.ts';
import { sshRun } from './relay.ts';
import { accountNames, emitChanged, isEntrypoint, publishAccounts, requiredOption, runSource, sourceStamp, sourceText, SourceError, watcherArguments, writeDiagnostic, writeRecord } from './source.ts';
import type { Emit, SourceMessage } from './source.ts';

// One Slack workspace read with the browser session slackcli keeps on the OE host (xoxc token and d cookie in its
// workspaces.json, renewed there by autologin oe-slack). The Web API calls run on that host with curl, so the session never
// leaves it. Read-only methods only; nothing is marked read.
export interface SlackRequest { method: string; params?: Record<string, string> }
export type SlackCall = (requests: SlackRequest[], signal?: AbortSignal) => Promise<unknown[]>;

const READ_METHODS = new Set(['auth.test', 'client.counts', 'subscriptions.thread.getView', 'conversations.history', 'conversations.replies', 'conversations.info', 'users.info']);
const STORE = '/opt/communication-mcp-state/slackcli/workspaces.json';
const B64 = (text: string) => Buffer.from(text).toString('base64');

export function slackCommand(workspace: string, requests: SlackRequest[], store = STORE): string {
  if (!/^T[A-Z0-9]+$/.test(workspace) || !/^\/[\w./-]+$/.test(store) || requests.some((r) => !READ_METHODS.has(r.method))) throw new SourceError('slack', 'slack.invalid-argument');
  const entries = requests.map((r) => `${r.method}:${B64(new URLSearchParams(r.params ?? {}).toString())}`).join(' ');
  const curl = `curl -sg --noproxy '*' --max-time 30 -H @"$t/h" -H 'Content-Type: application/x-www-form-urlencoded' -o "$t/o" -w '%{http_code}'`;
  const script = [
    'set -eu',
    `w=$(jq -c --arg w ${workspace} '.workspaces[$w] // empty' ${store})`,
    '[ -n "$w" ] || exit 2',
    't=$(mktemp -d); chmod 700 "$t"; trap \'rm -rf "$t"\' EXIT',
    // The d cookie is stored decoded; Slack only takes it URL-encoded, as a browser sends it.
    'printf \'Authorization: Bearer %s\\nCookie: d=%s\\n\' "$(printf %s "$w" | jq -j .xoxc_token)" "$(printf %s "$w" | jq -j .xoxd_token | jq -sRr @uri)" > "$t/h"',
    'u=$(printf %s "$w" | jq -j \'.workspace_url | rtrimstr("/")\')',
    `for r in ${entries}; do`,
    '  m=${r%%:*}; p=$(printf %s "${r#*:}" | base64 -d); : > "$t/o"',
    `  c=$(printf %s "$p" | ${curl} --data-binary @- "$u/api/$m") || c=000`,
    '  printf \'%s %s\\n\' "${c:-000}" "$(base64 -w0 < "$t/o")"',
    'done',
  ].join('\n');
  // Script and requests travel as base64, so the remote shell never interprets request data.
  return `bash -c "$(printf %s '${B64(script)}' | base64 -d)"`;
}

export function sshSlackCall(host: string, workspace: string, store?: string): SlackCall {
  return async (requests, signal) => {
    const out: unknown[] = [];
    for (let at = 0; at < requests.length; at += 25) {
      const chunk = requests.slice(at, at + 25);
      const output = await sshRun('slack', 'slack', { host, timeoutMs: 120_000, maxBytes: 32 * 1024 * 1024 }, slackCommand(workspace, chunk, store), signal);
      for (const [index, response] of parseOeOutput(output.toString('utf8'), chunk.length, 'slack').entries()) {
        let body: any;
        try { body = JSON.parse(response.body); } catch { throw new SourceError('slack', 'slack.response-json', undefined, response.status); }
        // 429 and 5xx are dependency failures (backoff); invalid_auth and the like name the cause in the reason.
        if (response.status !== 200 || body?.ok !== true) throw new SourceError('slack', 'slack.api', undefined, response.status === 200 ? 400 : response.status, `${chunk[index]!.method}:${String(body?.error ?? 'error').slice(0, 60)}`);
        out.push(body);
      }
    }
    return out;
  };
}

const ts = z.string().regex(/^\d+\.\d+$/);
const THREAD_DAYS = 3;
const counted = z.object({ id: z.string().min(1), latest: z.string().optional(), updated: z.string().optional() });
const counts = z.object({ channels: z.array(counted).default([]), mpims: z.array(counted).default([]), ims: z.array(counted).default([]) });
const message = z.looseObject({ ts, type: z.string().optional(), subtype: z.string().optional(), user: z.string().optional(), bot_id: z.string().optional(), username: z.string().optional(),
  text: z.string().optional(), thread_ts: ts.optional(), reply_count: z.number().optional(), latest_reply: ts.optional(), edited: z.unknown().optional(),
  files: z.array(z.looseObject({ name: z.string().optional(), title: z.string().optional(), size: z.number().optional() })).optional() });
const history = z.object({ messages: z.array(message), has_more: z.boolean().optional(), response_metadata: z.object({ next_cursor: z.string().optional() }).optional() });
const view = z.object({ threads: z.array(z.object({ root_msg: z.looseObject({ channel: z.string().min(1), ts, latest_reply: ts.optional() }) })).default([]) });
const channelInfo = z.object({ channel: z.looseObject({ id: z.string(), name: z.string().optional(), user: z.string().optional(), is_im: z.boolean().optional(), is_mpim: z.boolean().optional() }) });
const userInfo = z.object({ user: z.looseObject({ id: z.string(), name: z.string().optional(), real_name: z.string().optional(),
  profile: z.looseObject({ email: z.string().optional(), real_name: z.string().optional(), display_name: z.string().optional() }).optional() }) });
// Ordinary posts only: joins, leaves, topic changes and the like carry no request.
const KEPT = new Set([undefined, 'bot_message', 'thread_broadcast', 'file_share', 'me_message']);

export function createSlackState(options: { account: string; selfId: string; workspace: string; since: string; expectedAccounts?: string[] }) {
  const account = accountNames([options.account])[0]!;
  if (!account.includes('@') || !/^[UW][A-Z0-9]+$/.test(options.selfId) || !/^T[A-Z0-9]+$/.test(options.workspace)) throw new SourceError('slack', 'slack.invalid-options');
  if (accountNames(options.expectedAccounts ?? []).some((name) => name !== account)) throw new SourceError('slack', 'slack.account-mismatch');
  return { account, selfId: options.selfId, workspace: options.workspace, floor: sourceStamp(options.since), accounts: new Set<string>(), reported: '', seen: new Map<string, string>(),
    users: new Map<string, { name: string; email?: string }>(), conversations: new Map<string, { title: string }>() };
}
type SlackState = ReturnType<typeof createSlackState>;

const seconds = (stamp: string) => (Date.parse(stamp) / 1000).toFixed(6);
const parsed = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new SourceError('slack', 'slack.response-shape');
  return result.data;
};

function plain(state: SlackState, text: string): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${state.users.get(id)?.name ?? id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label: string | undefined) => label || '@group')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    // Dates, slack:// links and anything else with a fallback label read as the label.
    .replace(/<[^<>|]+\|([^<>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export async function scanSlack(call: SlackCall, state: SlackState, emit: Emit, now = () => new Date().toISOString(), signal?: AbortSignal): Promise<void> {
  const started = sourceStamp(now());
  const floor = seconds(new Date(Date.parse(state.floor) - 120_000).toISOString());
  const run = (requests: SlackRequest[]) => requests.length ? call(requests, signal) : Promise.resolve([]);
  const [auth, countsValue, viewValue] = await call([{ method: 'auth.test' }, { method: 'client.counts' }, { method: 'subscriptions.thread.getView', params: { limit: '50' } }], signal) as any[];
  if (auth?.user_id !== state.selfId || auth?.team_id !== state.workspace) throw new SourceError('slack', 'slack.account-mismatch');
  publishAccounts('slack', state, [state.account], emit);
  const c = parsed(counts, countsValue);
  // client.counts holds, per conversation of the user, its latest message and an `updated` time that a thread reply also
  // moves; only conversations with either newer than the floor are read.
  const active = [...c.channels, ...c.mpims, ...c.ims].filter((item) => Math.max(Number(item.latest ?? 0), Number(item.updated ?? 0)) > Number(floor)).map((item) => item.id);
  const threads = new Map<string, { channel: string; ts: string }>();
  for (const item of parsed(view, viewValue).threads) if (Number(item.root_msg.latest_reply ?? 0) > Number(floor)) threads.set(`${item.root_msg.channel}/${item.root_msg.ts}`, item.root_msg);
  const found: { channel: string; raw: z.infer<typeof message> }[] = [];
  // History goes back THREAD_DAYS past the floor so that a new reply under an older parent is found through the parent's
  // latest_reply; pages beyond the first are read only while they still hold messages newer than the floor.
  const oldest = (Number(floor) - THREAD_DAYS * 86400).toFixed(6);
  let pending = active.map((channel) => ({ channel, cursor: '' }));
  for (let round = 0; pending.length; round++) {
    if (round >= 10) throw new SourceError('slack', 'slack.pagination-limit');
    const pages = await run(pending.map(({ channel, cursor }) => ({ method: 'conversations.history', params: { channel, oldest, limit: '200', ...(cursor ? { cursor } : {}) } })));
    const next: typeof pending = [];
    pages.forEach((page, index) => {
      const { channel } = pending[index]!, h = parsed(history, page);
      for (const raw of h.messages) {
        found.push({ channel, raw });
        if (raw.reply_count && Number(raw.latest_reply ?? 0) > Number(floor)) threads.set(`${channel}/${raw.ts}`, { channel, ts: raw.ts });
      }
      const reached = h.messages.some((raw) => Number(raw.ts) <= Number(floor));
      if (h.has_more && h.response_metadata?.next_cursor && !reached) next.push({ channel, cursor: h.response_metadata.next_cursor });
    });
    pending = next;
  }
  const roots = [...threads.values()];
  const replies = await run(roots.map((root) => ({ method: 'conversations.replies', params: { channel: root.channel, ts: root.ts, oldest: floor, limit: '200' } })));
  replies.forEach((page, index) => { for (const raw of parsed(history, page).messages) if (raw.ts !== roots[index]!.ts) found.push({ channel: roots[index]!.channel, raw }); });

  const kept = found.filter(({ raw }) => KEPT.has(raw.subtype) && Number(raw.ts) > Number(floor));
  const channels = [...new Set(kept.map(({ channel }) => channel))].filter((id) => !state.conversations.has(id));
  const infos = await run(channels.map((channel) => ({ method: 'conversations.info', params: { channel } })));
  const ims = new Map<string, string>();
  infos.forEach((value, index) => {
    const info = parsed(channelInfo, value).channel;
    if (info.is_im && info.user) ims.set(channels[index]!, info.user);
    else state.conversations.set(channels[index]!, { title: info.is_mpim ? (info.name ?? info.id) : `#${info.name ?? info.id}` });
  });
  const mentioned = kept.flatMap(({ raw }) => [...(raw.text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]!));
  const users = [...new Set([...kept.map(({ raw }) => raw.user), ...ims.values(), ...mentioned].filter((id): id is string => !!id))].filter((id) => !state.users.has(id));
  const people = await run(users.map((user) => ({ method: 'users.info', params: { user } })));
  people.forEach((value) => {
    const user = parsed(userInfo, value).user;
    state.users.set(user.id, { name: user.profile?.real_name || user.real_name || user.profile?.display_name || user.name || user.id, ...(user.profile?.email ? { email: user.profile.email.toLowerCase() } : {}) });
  });
  for (const [channel, user] of ims) state.conversations.set(channel, { title: state.users.get(user)?.name ?? user });

  for (const { channel, raw } of kept.sort((a, b) => Number(a.raw.ts) - Number(b.raw.ts))) {
    const author = raw.user ? state.users.get(raw.user) : undefined;
    const record: SourceMessage = { source: 'slack', account: state.account, conversation_id: channel, conversation_title: state.conversations.get(channel)?.title ?? channel,
      message_id: `${channel}/${raw.ts}`, sender: author?.email ?? raw.user ?? raw.bot_id ?? 'unknown', sender_name: author?.name ?? raw.username ?? raw.user ?? 'bot',
      sender_is_me: raw.user === state.selfId, sent_at: new Date(Number(raw.ts) * 1000).toISOString(), text: sourceText(plain(state, raw.text ?? ''), 50000),
      attachments: (raw.files ?? []).map((file) => ({ name: file.name || file.title || '(unnamed)', ...(file.size === undefined ? {} : { size: file.size }) })),
      ref: { account: state.account, workspace: state.workspace, channel, ts: raw.ts, ...(raw.thread_ts && raw.thread_ts !== raw.ts ? { thread_ts: raw.thread_ts } : {}),
        ...(raw.edited ? { edited: true } : {}), ...((raw.text ?? '').includes(`<@${state.selfId}`) ? { mentions_me: true } : {}) } };
    if (state.seen.size >= 100000 && !state.seen.has(JSON.stringify(['slack', state.account, record.message_id]))) throw new SourceError('slack', 'slack.message-limit');
    emitChanged(state.seen, record, emit);
  }
  emit({ source: 'slack', accounts: [state.account], checkpoint: started });
  state.floor = started;
}

export async function slackMain(args = process.argv.slice(2)): Promise<number> {
  const options = watcherArguments(args, { host: { type: 'string' }, account: { type: 'string' }, 'self-id': { type: 'string' }, workspace: { type: 'string' }, store: { type: 'string' } });
  const state = createSlackState({ account: requiredOption(options.values, 'account'), selfId: requiredOption(options.values, 'self-id'), workspace: requiredOption(options.values, 'workspace'),
    since: options.since, expectedAccounts: options.expectedAccounts });
  const call = sshSlackCall(requiredOption(options.values, 'host'), state.workspace, options.values.store);
  return runSource('slack', options, (signal) => scanSlack(call, state, writeRecord, undefined, signal));
}

if (isEntrypoint(import.meta.url)) void slackMain().then((code) => { process.exitCode = code; }, (error: unknown) => { writeDiagnostic(error, 'slack'); process.exitCode = 1; });
