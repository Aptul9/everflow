import { z } from 'zod';
import { sshRun } from './relay.ts';
import { accountNames, emitChanged, isEntrypoint, publishAccounts, requiredOption, runSource, sourceStamp, sourceText, SourceError, watcherArguments, writeDiagnostic, writeRecord } from './source.ts';
import type { Emit, Source, SourceMessage } from './source.ts';
import { htmlToText } from './teams.ts';

// Mail of the OE Copilot agent mailboxes, read through its /api/communication gateway on the OE host.
// Same call shape as OE-Copilot mcp/src/service.ts sshGateway: the agent API_KEY and Microsoft tokens never leave the container.
export interface OeRequest { path: string; body?: unknown }
export type OeCall = (requests: OeRequest[], signal?: AbortSignal) => Promise<{ status: number; body: string }[]>;

const FOLDERS = ['Inbox', 'SentItems'] as const;
const FIELDS = 'Id,InternetMessageId,Subject,From,ReceivedDateTime,ConversationId,UniqueBody,HasAttachments,IsDraft';
const address = z.object({ EmailAddress: z.object({ Name: z.string().nullish(), Address: z.string().nullish() }).nullish() }).nullish();
const mailSchema = z.object({ Id: z.string().min(1), InternetMessageId: z.string().nullish(), Subject: z.string().nullish(), From: address,
  ReceivedDateTime: z.string().min(1), ConversationId: z.string().min(1), HasAttachments: z.boolean().nullish(), IsDraft: z.boolean().nullish(),
  UniqueBody: z.object({ ContentType: z.string(), Content: z.string() }).nullish() });
const pageSchema = z.object({ value: z.array(z.unknown()), '@odata.nextLink': z.string().nullish() });
const accountsSchema = z.object({ accounts: z.array(z.object({ upn: z.string(), status: z.string().nullish() })) });

// The agent image is a static binary with no shell or node (Rust agent, 2026-11-12), so the request runs on the OE host with bash and curl,
// against the agent port published on the host's loopback. The key is read from the container environment into a 0700 temporary file
// (never a command-line argument) and stays on the host. Output: one line per request, "<HTTP status> <base64 body>".
const B64 = (text: string) => Buffer.from(text).toString('base64');

export function oeCommand(requests: OeRequest[], container = 'oe-copilot-agent', port = 3180): string {
  if (!/^[A-Za-z0-9_][\w.-]*$/.test(container) || !Number.isInteger(port) || port < 1 || port > 65535) throw new SourceError('oemail', 'oemail.invalid-argument');
  const entries = requests.map((r) => `${B64(r.path)}:${r.body === undefined ? '' : B64(JSON.stringify(r.body))}`).join(' ');
  const curl = `curl -sg --noproxy '*' --max-time 30 -H @"$d/h" -o "$d/o" -w '%{http_code}'`;
  const script = [
    'set -eu',
    `k=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${container} | sed -n 's/^API_KEY=//p' | head -n 1)`,
    '[ -n "$k" ] || exit 2',
    'd=$(mktemp -d); chmod 700 "$d"; trap \'rm -rf "$d"\' EXIT',
    'printf \'Authorization: Bearer %s\\nContent-Type: application/json\\n\' "$k" > "$d/h"',
    `for r in ${entries}; do`,
    '  p=$(printf %s "${r%%:*}" | base64 -d); b=${r#*:}; : > "$d/o"',
    `  if [ -n "$b" ]; then c=$(printf %s "$b" | base64 -d | ${curl} --data-binary @- "http://127.0.0.1:${port}$p") || c=000`,
    `  else c=$(${curl} "http://127.0.0.1:${port}$p") || c=000; fi`,
    '  printf \'%s %s\\n\' "${c:-000}" "$(base64 -w0 < "$d/o")"',
    'done',
  ].join('\n');
  // Script and requests travel as base64, so the remote shell never interprets request data.
  return `bash -c "$(printf %s '${B64(script)}' | base64 -d)"`;
}

/** The lines of oeCommand: HTTP status and body of each request, in order. */
export function parseOeOutput(output: string, expected: number, source: Source = 'oemail'): { status: number; body: string }[] {
  const lines = output.split('\n').filter((line) => line !== '');
  const parsed = lines.map((line) => /^(\d{3}) ([A-Za-z0-9+/=]*)$/.exec(line));
  if (lines.length !== expected || parsed.some((m) => !m)) throw new SourceError(source, 'oemail.response-shape');
  return parsed.map((m) => ({ status: Number(m![1]), body: Buffer.from(m![2]!, 'base64').toString('utf8') }));
}

// Gmail and Google Chat read the same agent through this call; their errors keep the oemail.* transport codes under their own source.
export function sshOeCall(host: string, source: Source = 'oemail'): OeCall {
  return async (requests, signal) => {
    const output = await sshRun(source, 'oemail', { host, timeoutMs: 90_000, maxBytes: 32 * 1024 * 1024 }, oeCommand(requests), signal);
    return parseOeOutput(output.toString('utf8'), requests.length, source);
  };
}

function json(response: { status: number; body: string }, account?: string): unknown {
  if (response.status < 200 || response.status >= 300) throw new SourceError('oemail', 'oemail.http', account, response.status);
  try { return JSON.parse(response.body); } catch { throw new SourceError('oemail', 'oemail.response-json', account); }
}

// nextLink is an absolute Outlook REST URL; the gateway takes the path below /api/v2.0/
export function nextPath(link: string): string {
  let url: URL;
  try { url = new URL(link); } catch { throw new SourceError('oemail', 'oemail.pagination'); }
  const at = url.pathname.toLowerCase().indexOf('/api/v2.0/');
  if (at < 0) throw new SourceError('oemail', 'oemail.pagination');
  return url.pathname.slice(at + '/api/v2.0/'.length) + url.search;
}

function listPath(folder: string, floor: string): string {
  return `me/MailFolders/${folder}/messages?$top=50&$select=${FIELDS}&$filter=${encodeURIComponent(`ReceivedDateTime ge ${floor.replace(/\.\d+Z$/, 'Z')}`)}`
    + `&$orderby=${encodeURIComponent('ReceivedDateTime desc')}`;
}

export function normalize(value: unknown, account: string, folder: string): SourceMessage | null {
  const parsed = mailSchema.safeParse(value);
  if (!parsed.success) throw new SourceError('oemail', 'oemail.message-shape', account);
  const mail = parsed.data;
  if (mail.IsDraft) return null;
  const sender = mail.From?.EmailAddress?.Address?.trim().toLowerCase() ?? '';
  const time = Date.parse(mail.ReceivedDateTime);
  if (!Number.isFinite(time)) throw new SourceError('oemail', 'oemail.message-time', account);
  const body = mail.UniqueBody?.Content ?? '';
  const text = mail.UniqueBody?.ContentType.toLowerCase() === 'html' ? htmlToText(body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')) : body;
  return { source: 'oemail', account, conversation_id: mail.ConversationId, conversation_title: mail.Subject ?? '',
    // Folder-specific REST ids change on a move; the internet message id does not
    message_id: mail.InternetMessageId || mail.Id, sender, sender_name: mail.From?.EmailAddress?.Name ?? sender,
    sender_is_me: folder === 'SentItems' || sender === account, sent_at: new Date(time).toISOString(), text: sourceText(text.trim(), 50000),
    attachments: mail.HasAttachments ? [{ name: '(attachments)' }] : [], ref: { account, id: mail.Id, folder, conversation: mail.ConversationId } };
}

export function createOeMailState(options: { accounts: string[]; since: string; expectedAccounts?: string[] }) {
  const accounts = accountNames(options.accounts);
  if (!accounts.length || accounts.some((name) => !name.includes('@'))) throw new SourceError('oemail', 'oemail.account-required');
  return { wanted: accounts, floor: sourceStamp(options.since), accounts: new Set<string>(), reported: '', seen: new Map<string, string>() };
}

export async function scanOeMail(call: OeCall, state: ReturnType<typeof createOeMailState>, emit: Emit, now = () => new Date().toISOString(), signal?: AbortSignal): Promise<void> {
  const started = sourceStamp(now());
  const floor = new Date(Date.parse(state.floor) - 120_000).toISOString();
  const [listing] = await call([{ path: '/api/communication/accounts' }], signal);
  const known = accountsSchema.safeParse(json(listing!));
  if (!known.success) throw new SourceError('oemail', 'oemail.response-shape');
  const status = new Map(known.data.accounts.map((item) => [item.upn.toLowerCase(), item.status ?? 'ok']));
  const ready = state.wanted.filter((account) => status.get(account) === 'ok');
  publishAccounts('oemail', state, ready, emit);
  let pending = ready.flatMap((account) => FOLDERS.map((folder) => ({ account, folder, path: listPath(folder, floor) })));
  for (let round = 0; pending.length; round++) {
    signal?.throwIfAborted();
    if (round >= 20) throw new SourceError('oemail', 'oemail.pagination');
    const responses = await call(pending.map((item) => ({ path: '/api/communication/read', body: { account: item.account, path: item.path } })), signal);
    const next: typeof pending = [];
    responses.forEach((response, index) => {
      const item = pending[index]!;
      const page = pageSchema.safeParse(json(response, item.account));
      if (!page.success) throw new SourceError('oemail', 'oemail.response-shape', item.account);
      for (const value of page.data.value) {
        const record = normalize(value, item.account, item.folder);
        if (!record) continue;
        if (state.seen.size >= 100000 && !state.seen.has(JSON.stringify(['oemail', item.account, record.message_id]))) throw new SourceError('oemail', 'oemail.message-limit');
        emitChanged(state.seen, record, emit);
      }
      if (page.data['@odata.nextLink']) next.push({ ...item, path: nextPath(page.data['@odata.nextLink']) });
    });
    pending = next;
  }
  // A mailbox the agent cannot read keeps the floor, so nothing it receives meanwhile is skipped
  const missing = state.wanted.find((account) => status.get(account) !== 'ok');
  if (missing) throw new SourceError('oemail', 'oemail.account-unavailable', missing, undefined, status.get(missing) ?? 'absent');
  emit({ source: 'oemail', accounts: state.wanted, checkpoint: started });
  state.floor = started;
}

export async function oeMailMain(args = process.argv.slice(2)): Promise<number> {
  const options = watcherArguments(args, { host: { type: 'string' }, account: { type: 'string', multiple: true } });
  const state = createOeMailState({ accounts: options.values.account ?? [], since: options.since, expectedAccounts: options.expectedAccounts });
  const call = sshOeCall(requiredOption(options.values, 'host'));
  return runSource('oemail', options, (signal) => scanOeMail(call, state, writeRecord, undefined, signal));
}

if (isEntrypoint(import.meta.url)) void oeMailMain().then((code) => { process.exitCode = code; }, (error: unknown) => { writeDiagnostic(error, 'oemail'); process.exitCode = 1; });
