import { z } from 'zod';
import { sshRun } from './relay.ts';
import { accountNames, emitChanged, isEntrypoint, publishAccounts, requiredOption, runSource, sourceStamp, sourceText, SourceError, watcherArguments, writeDiagnostic, writeRecord } from './source.ts';
import type { Emit, SourceMessage } from './source.ts';
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

export function oeCommand(requests: OeRequest[], container = 'oe-copilot-agent', port = 8180): string {
  if (!/^[A-Za-z0-9_][\w.-]*$/.test(container) || !Number.isInteger(port) || port < 1 || port > 65535) throw new SourceError('oemail', 'oemail.invalid-argument');
  const input = Buffer.from(JSON.stringify(requests)).toString('base64');
  const script = `const q=JSON.parse(Buffer.from('${input}','base64').toString());const out=[];for(const i of q){const r=await fetch('http://127.0.0.1:${port}'+i.path,{method:i.body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+process.env.API_KEY,'Content-Type':'application/json'},body:i.body===undefined?undefined:JSON.stringify(i.body),redirect:'error',signal:AbortSignal.timeout(30000)});out.push({status:r.status,body:await r.text()});}process.stdout.write(JSON.stringify(out));`;
  // Both payloads are base64, so the remote shell never interprets request data.
  return `docker exec -i ${container} node --input-type=module -e "await import('data:text/javascript;base64,${Buffer.from(script).toString('base64')}')"`;
}

export function sshOeCall(host: string): OeCall {
  return async (requests, signal) => {
    const output = await sshRun('oemail', 'oemail', { host, timeoutMs: 90_000, maxBytes: 32 * 1024 * 1024 }, oeCommand(requests), signal);
    let value: unknown;
    try { value = JSON.parse(output.toString('utf8')); } catch { throw new SourceError('oemail', 'oemail.response-json'); }
    const parsed = z.array(z.object({ status: z.number().int(), body: z.string() })).safeParse(value);
    if (!parsed.success || parsed.data.length !== requests.length) throw new SourceError('oemail', 'oemail.response-shape');
    return parsed.data;
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
