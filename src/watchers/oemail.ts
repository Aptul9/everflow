import { z } from 'zod';
import { oeEndpoint, oeRequest } from './oe-endpoint.ts';
import type { OeEndpoint } from './oe-endpoint.ts';
import { accountNames, emitChanged, isEntrypoint, publishAccounts, runSource, sourceStamp, sourceText, SourceError, watcherArguments, writeDiagnostic, writeRecord } from './source.ts';
import type { Emit, Source, SourceMessage } from './source.ts';
import { htmlToText } from './teams.ts';

// Mail of the OE Copilot agent mailboxes, read through its /api/communication gateway behind the OE endpoint.
// The agent API_KEY and Microsoft tokens never leave the OE host.
export interface OeRequest { path: string; body?: unknown }
export type OeCall = (requests: OeRequest[], signal?: AbortSignal) => Promise<{ status: number; body: string }[]>;

const FOLDERS = ['Inbox', 'SentItems'] as const;
const FIELDS = 'Id,InternetMessageId,Subject,From,ToRecipients,CcRecipients,ReceivedDateTime,ConversationId,UniqueBody,HasAttachments,IsDraft';
const address = z.object({ EmailAddress: z.object({ Name: z.string().nullish(), Address: z.string().nullish() }).nullish() }).nullish();
const mailSchema = z.object({ Id: z.string().min(1), InternetMessageId: z.string().nullish(), Subject: z.string().nullish(), From: address,
  ToRecipients: z.array(address).nullish(), CcRecipients: z.array(address).nullish(),
  ReceivedDateTime: z.string().min(1), ConversationId: z.string().min(1), HasAttachments: z.boolean().nullish(), IsDraft: z.boolean().nullish(),
  UniqueBody: z.object({ ContentType: z.string(), Content: z.string() }).nullish() });
const pageSchema = z.object({ value: z.array(z.unknown()), '@odata.nextLink': z.string().nullish() });
const accountsSchema = z.object({ accounts: z.array(z.object({ upn: z.string(), status: z.string().nullish() })) });

const responsesSchema = z.object({ responses: z.array(z.object({ status: z.number().int(), body: z.string() })) });

// The requests go to the agent through the OE endpoint (/everflow/agent), which answers each one's status and body in order.
// Gmail and Google Chat read the same agent through this call; their errors keep the oemail.* transport codes under their own source.
export function httpOeCall(endpoint: OeEndpoint, source: Source = 'oemail'): OeCall {
  return async (requests, signal) => {
    const answer = responsesSchema.safeParse(await oeRequest(source, 'oemail', endpoint, 'agent', { method: 'POST', body: { requests } }, signal));
    if (!answer.success || answer.data.responses.length !== requests.length) throw new SourceError(source, 'oemail.response-shape');
    return answer.data.responses;
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
  const mine = folder === 'SentItems' || sender === account;
  const listed = (recipients: typeof mail.ToRecipients) => (recipients ?? []).some((item) => item?.EmailAddress?.Address?.trim().toLowerCase() === account.toLowerCase());
  return { source: 'oemail', account, conversation_id: mail.ConversationId, conversation_title: mail.Subject ?? '',
    // Folder-specific REST ids change on a move; the internet message id does not
    message_id: mail.InternetMessageId || mail.Id, sender, sender_name: mail.From?.EmailAddress?.Name ?? sender,
    sender_is_me: mine, sent_at: new Date(time).toISOString(), text: sourceText(text.trim(), 50000),
    attachments: mail.HasAttachments ? [{ name: '(attachments)' }] : [], ref: { account, id: mail.Id, folder, conversation: mail.ConversationId,
      // Where the mailbox stood on someone else's mail: other means a distribution list or Bcc
      ...(mine ? {} : { addressed: listed(mail.ToRecipients) ? 'to' : listed(mail.CcRecipients) ? 'cc' : 'other' }) } };
}

export function createOeMailState(options: { accounts: string[]; since: string; expectedAccounts?: string[] }) {
  const accounts = accountNames(options.accounts);
  if (!accounts.length || accounts.some((name) => !name.includes('@'))) throw new SourceError('oemail', 'oemail.account-required');
  const floor = sourceStamp(options.since);
  return { wanted: accounts, floor, floors: new Map(accounts.map((account) => [account, floor])), failures: new Map<string, string>(),
    accounts: new Set<string>(), reported: '', seen: new Map<string, string>() };
}

// Each mailbox keeps its own floor, so one the agent cannot read (expired sign-in, 502) holds back only itself. The checkpoint is the
// oldest floor, so a restart rereads what that mailbox missed; failed accounts ride on it so their health stays failing.
export async function scanOeMail(call: OeCall, state: ReturnType<typeof createOeMailState>, emit: Emit, now = () => new Date().toISOString(), signal?: AbortSignal,
  report: (error: SourceError) => void = (error) => writeDiagnostic(error, 'oemail')): Promise<void> {
  const started = sourceStamp(now());
  const [listing] = await call([{ path: '/api/communication/accounts' }], signal);
  const known = accountsSchema.safeParse(json(listing!));
  if (!known.success) throw new SourceError('oemail', 'oemail.response-shape');
  const status = new Map(known.data.accounts.map((item) => [item.upn.toLowerCase(), item.status ?? 'ok']));
  const ready = state.wanted.filter((account) => status.get(account) === 'ok');
  publishAccounts('oemail', state, ready, emit);
  const failed = new Map<string, SourceError>(state.wanted.filter((account) => status.get(account) !== 'ok')
    .map((account) => [account, new SourceError('oemail', 'oemail.account-unavailable', account, undefined, status.get(account) ?? 'absent')]));
  const since = (account: string) => new Date(Date.parse(state.floors.get(account)!) - 120_000).toISOString();
  let pending = ready.flatMap((account) => FOLDERS.map((folder) => ({ account, folder, path: listPath(folder, since(account)) })));
  for (let round = 0; pending.length; round++) {
    signal?.throwIfAborted();
    if (round >= 20) throw new SourceError('oemail', 'oemail.pagination');
    const responses = await call(pending.map((item) => ({ path: '/api/communication/read', body: { account: item.account, path: item.path } })), signal);
    const next: typeof pending = [];
    responses.forEach((response, index) => {
      const item = pending[index]!;
      if (failed.has(item.account)) return;
      try {
        const page = pageSchema.safeParse(json(response, item.account));
        if (!page.success) throw new SourceError('oemail', 'oemail.response-shape', item.account);
        for (const value of page.data.value) {
          const record = normalize(value, item.account, item.folder);
          if (!record) continue;
          if (state.seen.size >= 100000 && !state.seen.has(JSON.stringify(['oemail', item.account, record.message_id]))) throw new SourceError('oemail', 'oemail.message-limit');
          emitChanged(state.seen, record, emit);
        }
        if (page.data['@odata.nextLink']) next.push({ ...item, path: nextPath(page.data['@odata.nextLink']) });
      } catch (error) {
        if (!(error instanceof SourceError) || error.account !== item.account || error.code === 'oemail.message-limit') throw error;
        failed.set(item.account, error);
      }
    });
    pending = next.filter((item) => !failed.has(item.account));
  }
  for (const account of state.wanted) if (!failed.has(account)) state.floors.set(account, started);
  state.floor = [...state.floors.values()].sort()[0]!;
  emit({ source: 'oemail', accounts: state.wanted, checkpoint: state.floor, ...(failed.size ? { failed: [...failed.keys()] } : {}) });
  for (const account of state.wanted) {
    const error = failed.get(account), key = error ? JSON.stringify([error.code, error.status, error.reason]) : undefined;
    if (error && state.failures.get(account) !== key) report(error);
    if (key) state.failures.set(account, key); else state.failures.delete(account);
  }
}

export async function oeMailMain(args = process.argv.slice(2)): Promise<number> {
  const options = watcherArguments(args, { account: { type: 'string', multiple: true } });
  const state = createOeMailState({ accounts: options.values.account ?? [], since: options.since, expectedAccounts: options.expectedAccounts });
  const call = httpOeCall(oeEndpoint('oemail', 'oemail'));
  return runSource('oemail', options, (signal) => scanOeMail(call, state, writeRecord, undefined, signal));
}

if (isEntrypoint(import.meta.url)) void oeMailMain().then((code) => { process.exitCode = code; }, (error: unknown) => { writeDiagnostic(error, 'oemail'); process.exitCode = 1; });
