import { join } from 'node:path';
import { decodeHTML } from 'entities';
import { discoverTeamsProfile, jwtMetadata, liveTeamsAccounts, protectedTeamsCache, TeamsAuth } from './teams-auth.ts';
import type { TeamsAccount } from './teams-auth.ts';
import { accountNames, emitChanged, isEntrypoint, publishAccounts, requiredOption, runSource, safeSourceDiagnostic, sourceStamp, SourceError, watcherArguments, writeDiagnostic, writeRecord } from './source.ts';
import type { Emit, SourceMessage } from './source.ts';

export const TEAMS_ORIGIN = 'https://teams.microsoft.com';
export const TEAMS_NODE_FLAGS = ['--use-system-ca'] as const;
const HIDDEN = ['48:calllogs', '48:notifications', '48:mentions', '48:drafts', '48:threads', '48:saved'];
const SKIP_TYPES = ['ThreadActivity', 'Control/', 'Event/'];

export interface TeamsPort {
  knownAccounts(): string[];
  accounts(signal?: AbortSignal): Promise<TeamsAccount[]>;
  request(account: TeamsAccount, url: string, signal?: AbortSignal): Promise<any>;
}
export function teamsUrl(link: string, region: string, base?: string): string {
  if (!/^[a-z][a-z0-9]{0,15}$/.test(region)) throw new SourceError('teams', 'teams.region');
  let url: URL;
  try { url = new URL(link, base ?? `${TEAMS_ORIGIN}/api/chatsvc/${region}/v1/`); }
  catch { throw new SourceError('teams', 'teams.origin'); }
  if (url.origin !== TEAMS_ORIGIN || url.username || url.password || url.hash) throw new SourceError('teams', 'teams.origin');
  return url.href;
}

export class TeamsClient {
  private readonly auth: { refreshRejected(account: TeamsAccount, signal?: AbortSignal): Promise<TeamsAccount> };
  private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly replacements = new Map<string, { rejected: string; account: TeamsAccount }>();
  constructor(auth: { refreshRejected(account: TeamsAccount, signal?: AbortSignal): Promise<TeamsAccount> }, fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch) { this.auth = auth; this.fetcher = fetcher; }
  async request(account: TeamsAccount, input: string, signal?: AbortSignal): Promise<any> {
    const url = teamsUrl(input, account.region);
    if (!/^\/api\/chatsvc\/[a-z0-9]+\/v1\/users\/ME\/conversations(?:\/[^/]+\/messages)?\/?$/.test(new URL(url).pathname)) throw new SourceError('teams', 'teams.read-endpoint', account.upn);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const stop = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const replacement = this.replacements.get(account.upn.toLowerCase());
    let current = replacement?.rejected === account.ic3 ? replacement.account : account;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        stop.throwIfAborted();
        const response = await this.fetcher(url, { method: 'GET', redirect: 'manual', signal: stop, headers: {
          Accept: 'application/json', Origin: TEAMS_ORIGIN, Referer: TEAMS_ORIGIN + '/v2/', Authorization: 'Bearer ' + current.ic3,
        } });
        if (response.status === 401 && attempt === 0) {
          await response.body?.cancel();
          current = await this.auth.refreshRejected(current, stop);
          if (current.upn.toLowerCase() !== account.upn.toLowerCase()) throw new SourceError('teams', 'teams.refresh-account', account.upn);
          this.replacements.set(account.upn.toLowerCase(), { rejected: account.ic3, account: current });
          continue;
        }
        if (response.status !== 200) { await response.body?.cancel(); throw new SourceError('teams', 'teams.http', account.upn, response.status); }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (!reader) throw new SourceError('teams', 'teams.response-json', account.upn);
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 8 * 1024 * 1024) throw new SourceError('teams', 'teams.response-limit', account.upn);
            chunks.push(chunk.value);
          }
        } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new SourceError('teams', 'teams.response-json', account.upn); }
      }
      throw new SourceError('teams', 'teams.http', account.upn, 401);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if (stop.aborted) throw new SourceError('teams', signal?.aborted ? 'teams.aborted' : 'teams.timeout', account.upn);
      const diagnostic = safeSourceDiagnostic(error, 'teams');
      throw new SourceError('teams', 'teams.request-failed', account.upn, diagnostic.status, diagnostic.reason ?? diagnostic.code);
    } finally { clearTimeout(timer); }
  }
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceError('teams', 'teams.response-shape');
  return value as Record<string, any>;
}

function messageTime(value: unknown): string {
  if (typeof value !== 'string') throw new SourceError('teams', 'teams.message-time');
  try { return sourceStamp(value.replace(/(\.\d{6})\d+(?=Z|[+-]\d\d:\d\d$)/, '$1')); }
  catch { throw new SourceError('teams', 'teams.message-time'); }
}

function deletionTime(value: unknown): string {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+$/.test(value))) return messageTime(value);
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) throw new SourceError('teams', 'teams.message-time');
  try { return sourceStamp(new Date(milliseconds).toISOString()); }
  catch { throw new SourceError('teams', 'teams.message-time'); }
}

export async function teamsPages(port: Pick<TeamsPort, 'request'>, account: TeamsAccount, input: string, key: 'messages' | 'conversations', sinceMs: number, signal?: AbortSignal, limit = 10): Promise<any[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SourceError('teams', 'teams.pagination-limit', account.upn);
  let url = teamsUrl(input, account.region);
  const pages = new Set<string>(), out: any[] = [];
  for (let pageNumber = 0; pageNumber < limit; pageNumber++) {
    signal?.throwIfAborted();
    if (pages.has(url)) throw new SourceError('teams', 'teams.pagination-limit', account.upn);
    pages.add(url);
    const page = object(await port.request(account, url, signal));
    const batch = page[key];
    if (!Array.isArray(batch) || batch.length > 200) throw new SourceError('teams', 'teams.page-shape', account.upn);
    batch.forEach(object); out.push(...batch);
    const metadata = page._metadata === undefined ? {} : object(page._metadata);
    const link = metadata.backwardLink;
    if (link !== undefined && typeof link !== 'string') throw new SourceError('teams', 'teams.page-shape', account.upn);
    const older = key === 'messages' && batch.some((raw) => raw.originalarrivaltime && Date.parse(messageTime(raw.originalarrivaltime)) < sinceMs);
    if (!batch.length || !link || older) return out;
    url = teamsUrl(link, account.region, url);
  }
  throw new SourceError('teams', 'teams.pagination-limit', account.upn);
}

type MessageMetadata = Pick<SourceMessage, 'sent_at' | 'sender' | 'sender_name' | 'sender_is_me'>;
export function createTeamsState(since: string, expectedAccounts: string[] = []) {
  return { since: sourceStamp(since), accounts: new Set(accountNames(expectedAccounts)), cursors: new Map<string, string>(), seen: new Map<string, string>(), metadata: new Map<string, MessageMetadata>(), reported: '' };
}

function senderOid(raw: Record<string, any>): string { return String(raw.from || '').split('/').at(-1)!.split(':').at(-1)!; }

function title(conversation: Record<string, any>, raws: Record<string, any>[], me: string): string {
  if (conversation.id === '48:notes') return 'Notes (self chat)';
  const properties = conversation.threadProperties ? object(conversation.threadProperties) : {};
  for (const key of ['topic', 'spaceThreadTopic', 'threadTopic']) if (typeof properties[key] === 'string' && properties[key]) return properties[key];
  return [...new Set(raws.filter((raw) => senderOid(raw) !== me && typeof raw.imdisplayname === 'string' && raw.imdisplayname).map((raw) => raw.imdisplayname as string))].sort().join(', ');
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}=["']([^"']*)["']`, 'i').exec(tag);
  return match ? decodeHTML(match[1]!) : '';
}

export function htmlToText(input: string): string {
  const pre: string[] = [];
  let text = input.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_all, content: string) => { pre.push(content); return `\0${pre.length - 1}\0`; }).replace(/\s*\n\s*/g, ' ');
  text = text.replace(/<blockquote[^>]*schema\.skype\.com\/Reply[^>]*>([\s\S]*?)<\/blockquote>/gi, (_all, content: string) => {
    const strip = (value: string) => decodeHTML(value.replace(/<[^>]+>/g, '')).trim();
    const who = /<strong[^>]*>([\s\S]*?)<\/strong>/i.exec(content)?.[1] ?? '?';
    const preview = /itemprop=["']preview["'][^>]*>([\s\S]*?)<\/p>/i.exec(content)?.[1] ?? '';
    const time = /itemprop=["']time["'][^>]*itemid=["'](\d+)["']/i.exec(content)?.[1];
    const stamp = time && Number.isFinite(new Date(Number(time)).getTime()) ? new Date(Number(time)).toISOString() : '?';
    return `\n> in reply to ${strip(who)} (${stamp}): ${strip(preview)}\n`;
  });
  text = text.replace(/<img[^>]*>/gi, (tag) => /schema\.skype\.com\/Emoji/i.test(tag) ? attribute(tag, 'alt') : /\.gif|giphy/i.test(tag) ? `[GIF${attribute(tag, 'alt') ? ': ' + attribute(tag, 'alt') : ''}]` : '[image]')
    .replace(/<span[^>]*schema\.skype\.com\/Mention[^>]*>([\s\S]*?)<\/span>/gi, '@$1')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_all, href: string, label: string) => label.replace(/<[^>]+>/g, '').trim() === href ? label : `${label} (${href})`)
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>|<\/h\d>/gi, '\n').replace(/<li[^>]*>/gi, '- ');
  text = decodeHTML(text.replace(/<[^>]+>/g, '')).replaceAll('\u00a0', ' ').replaceAll('\uFFFD', '').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.replace(/\0(\d+)\0/g, (_all, index: string) => '\n' + decodeHTML((pre[Number(index)] ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/^\n|\n$/g, '') + '\n').trim();
}

function files(properties: Record<string, any>): any[] {
  if (Array.isArray(properties.files)) return properties.files;
  if (typeof properties.files !== 'string' || !properties.files.startsWith('[')) return [];
  try { const result: unknown = JSON.parse(properties.files); return Array.isArray(result) ? result : []; } catch { return []; }
}

function normalize(raw: Record<string, any>, conversation: string, conversationTitle: string, account: TeamsAccount, previous?: MessageMetadata): SourceMessage | null {
  const properties = raw.properties ? object(raw.properties) : {};
  const deletion = properties.deletetime;
  const deletionStamp = deletion === undefined || deletion === null || deletion === '' ? undefined : deletionTime(deletion);
  const deleted = raw.deleted === true || raw.deletionInfo === true || properties.deleted === true || Boolean(properties.deletetime);
  const kind = String(raw.messagetype || '');
  if (SKIP_TYPES.some((prefix) => kind.startsWith(prefix)) || !kind && !deleted) return null;
  if ((typeof raw.id !== 'string' && typeof raw.id !== 'number') || !String(raw.id)) throw new SourceError('teams', 'teams.message-id', account.upn);
  const id = String(raw.id), sender = raw.from ? senderOid(raw) : previous?.sender ?? '';
  const me = account.oid || jwtMetadata(account.ic3).oid || '';
  const sentAt = raw.originalarrivaltime || raw.composetime;
  const stamp = messageTime(deleted && previous ? previous.sent_at : sentAt || previous?.sent_at || deletionStamp);
  const attachments: SourceMessage['attachments'] = [];
  let text = '';
  if (!deleted) {
    const content = String(raw.content || '');
    text = kind.startsWith('RichText/Media_Call') || kind === 'Event/Call' ? '[call or recording]' : kind.startsWith('RichText') || content.includes('<') ? htmlToText(content) : content.trim();
    for (const tag of content.match(/<img[^>]*>/gi) ?? []) {
      const src = attribute(tag, 'src');
      try {
        const url = new URL(src);
        if (!['http:', 'https:'].includes(url.protocol) || /schema\.skype\.com\/emoji/i.test(tag) || url.hostname.startsWith('statics')) continue;
        attachments.push({ name: /\.gif|giphy/i.test(src) ? 'gif' : 'image', size: null });
      } catch { /* Non-URL images are not attachment metadata. */ }
    }
    for (const file of files(properties)) {
      if (!file || typeof file !== 'object') continue;
      const name = String(file.fileName || file.title || '?');
      attachments.push({ name, size: null }); text += `\n[file: ${name}]`;
    }
    if (properties.subject) text = String(properties.subject) + '\n' + text;
    if (!text) text = '[no text content]';
  }
  return { source: 'teams', account: account.upn.toLowerCase(), conversation_id: conversation, conversation_title: conversationTitle,
    message_id: `${conversation};messageid=${id}`, sender, sender_name: String(raw.imdisplayname || raw.fromDisplayNameInToken || previous?.sender_name || ''),
    sender_is_me: raw.from ? Boolean(me && sender === me) : previous?.sender_is_me ?? false, sent_at: stamp, text, attachments,
    ref: { chat: conversation, id, account: account.upn.toLowerCase(), ...(properties.edittime ? { edited_at: String(properties.edittime) } : {}), ...(deleted ? { deleted: true } : {}) } };
}

export async function scanTeams(port: TeamsPort, state: ReturnType<typeof createTeamsState>, emit: Emit, now: () => number = Date.now, signal?: AbortSignal): Promise<void> {
  const began = new Date(now()).toISOString();
  let active: TeamsAccount[] = [], discoveryFailed = false;
  let discovery: ReturnType<typeof safeSourceDiagnostic> | undefined;
  try {
    for (const name of accountNames(port.knownAccounts())) state.accounts.add(name);
    active = await port.accounts(signal);
  } catch (error) { discoveryFailed = true; discovery = safeSourceDiagnostic(error, 'teams'); }
  try { for (const name of accountNames(port.knownAccounts())) state.accounts.add(name); }
  catch (error) { discoveryFailed = true; discovery ??= safeSourceDiagnostic(error, 'teams'); }
  const expected = publishAccounts('teams', state, active.map((account) => account.upn), emit);
  const names = accountNames(active.map((account) => account.upn));
  const missing = expected.filter((name) => !names.includes(name));
  const failed: { account?: string; status?: number; reason: string }[] = [];
  if (discoveryFailed || !active.length || names.length !== active.length || missing.length) failed.push({
    ...(missing[0] ? { account: missing[0] } : {}), ...(discovery?.status === undefined ? {} : { status: discovery.status }),
    reason: discovery?.reason ?? discovery?.code ?? (missing.length ? 'teams.accounts-missing' : 'teams.accounts-incomplete'),
  });
  for (const account of active) {
    const name = account.upn.toLowerCase();
    const accountBegan = new Date(now()).toISOString();
    try {
      const floor = Date.parse(state.cursors.get(name) ?? state.since) - 120000;
      const base = `${TEAMS_ORIGIN}/api/chatsvc/${account.region}/v1/users/ME/conversations`;
      const query = `?view=msnp24Equivalent&pageSize=200&startTime=${floor}`;
      const conversations = await teamsPages(port, account, base + query, 'conversations', floor, signal);
      const visited = new Set<string>();
      for (const conversation of conversations) {
        const id = conversation.id;
        if (typeof id !== 'string' || !id || HIDDEN.some((prefix) => id.startsWith(prefix)) || visited.has(id)) continue;
        visited.add(id);
        const raws = await teamsPages(port, account, `${base}/${encodeURIComponent(id)}/messages${query}`, 'messages', floor, signal);
        const me = account.oid || jwtMetadata(account.ic3).oid || '';
        const conversationTitle = title(conversation, raws, me);
        for (const raw of raws) {
          const identity = JSON.stringify([name, id, String(raw.id)]);
          const record = normalize(raw, id, conversationTitle, account, state.metadata.get(identity));
          if (!record) continue;
          const properties = raw.properties || {};
          if (Date.parse(record.sent_at) < floor && !properties.edittime && record.ref.deleted !== true) continue;
          emitChanged(state.seen, record, emit);
          state.metadata.set(identity, { sent_at: record.sent_at, sender_is_me: record.sender_is_me, ...(record.sender === undefined ? {} : { sender: record.sender }), ...(record.sender_name === undefined ? {} : { sender_name: record.sender_name }) });
        }
      }
      state.cursors.set(name, accountBegan);
    } catch (error) {
      const diagnostic = safeSourceDiagnostic(error, 'teams');
      failed.push({ account: name, ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }), reason: diagnostic.reason ?? diagnostic.code });
    }
  }
  if (failed.length) throw new SourceError('teams', 'teams.scan-incomplete', failed[0]?.account, failed[0]?.status, failed[0]?.reason);
  emit({ source: 'teams', checkpoint: began, accounts: expected }); state.since = began;
}

export async function teamsMain(args = process.argv.slice(2)): Promise<number> {
  const options = watcherArguments(args, { cache: { type: 'string' }, 'bootstrap-cache': { type: 'string' }, profile: { type: 'string' }, 'scratch-root': { type: 'string' } });
  const path = requiredOption(options.values, 'cache'), scratchRoot = requiredOption(options.values, 'scratch-root');
  const cache = protectedTeamsCache({ path, ...(options.values['bootstrap-cache'] ? { bootstrap: String(options.values['bootstrap-cache']) } : {}) });
  const auth = new TeamsAuth({ ...cache, harvest: (signal) => {
    const profile = options.values.profile ? String(options.values.profile) : discoverTeamsProfile(join(process.env.LOCALAPPDATA ?? '', 'Packages', 'MSTeams_8wekyb3d8bbwe', 'LocalCache', 'Microsoft', 'MSTeams', 'EBWebView'));
    return liveTeamsAccounts({ profile, scratchRoot }, signal);
  } });
  const client = new TeamsClient(auth);
  const state = createTeamsState(options.since, options.expectedAccounts);
  return runSource('teams', options, (signal) => scanTeams({ knownAccounts: () => auth.knownAccounts(), accounts: (stop) => auth.accounts(stop), request: (account, url, stop) => client.request(account, url, stop) }, state, writeRecord, undefined, signal));
}

if (isEntrypoint(import.meta.url)) void teamsMain().then((code) => { process.exitCode = code; }, (error: unknown) => { writeDiagnostic(error, 'teams'); process.exitCode = 1; });
