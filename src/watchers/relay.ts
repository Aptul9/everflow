import { z } from 'zod';
import { oeEndpoint, oeRequest } from './oe-endpoint.ts';
import type { OeEndpoint } from './oe-endpoint.ts';
import { accountNames, emitChanged, isEntrypoint, publishAccounts, runSource, sourceStamp, sourceText, SourceError, watcherArguments, writeDiagnostic, writeRecord } from './source.ts';
import type { Emit, SourceMessage } from './source.ts';

export interface RelayOptions { maxRows?: number; maxAccounts?: number }
/**
 * The saved messages of every active Teams relay account of the token's owner since `floor` (ms), in slot order: each slot's
 * snapshot text (OE-Copilot teams-relay /api/everflow/saved, at most maxRows + 1 messages), or the error that slot alone hit.
 */
export type RelaySaved = (floor: number, maxRows: number, signal?: AbortSignal) => Promise<{ slot: number; snapshot?: string; error?: string }[]>;
export interface RelaySnapshot { accounts: { slot: number; email: string; scanAt: number; muted: string[]; messages: SourceMessage[] }[]; errors: { code: string; account: string }[] }

const savedSchema = z.object({ slots: z.array(z.union([z.object({ slot: z.unknown(), snapshot: z.string() }), z.object({ slot: z.unknown(), error: z.string() })])) });

export function httpRelaySaved(endpoint: OeEndpoint): RelaySaved {
  return async (floor, maxRows, signal) => {
    const answer = savedSchema.safeParse(await oeRequest('teamsrelay', 'relay', endpoint, 'teams', { method: 'GET', query: { since: String(floor), max_rows: String(maxRows) } }, signal));
    if (!answer.success) throw new SourceError('teamsrelay', 'relay.response-json');
    return answer.data.slots as { slot: number; snapshot?: string; error?: string }[];
  };
}

function jsonObject(value: unknown): Record<string, any> {
  let result: unknown;
  try { result = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new SourceError('teamsrelay', 'relay.saved-json'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SourceError('teamsrelay', 'relay.saved-shape');
  return result as Record<string, any>;
}

function numericSlot(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw new SourceError('teamsrelay', 'relay.invalid-slot');
  return number;
}

function normalize(email: string, slot: number, raw: Record<string, any>): SourceMessage {
  if (typeof raw.mid !== 'string' || !/^\d+$/.test(raw.mid) || !Number.isSafeInteger(Number(raw.mid)) || !Number.isFinite(new Date(Number(raw.mid)).getTime())) throw new SourceError('teamsrelay', 'relay.message-time');
  if (typeof raw.chat !== 'string' || !raw.chat || raw.mine !== 0 && raw.mine !== 1 && typeof raw.mine !== 'boolean') throw new SourceError('teamsrelay', 'relay.message-shape');
  const extra = jsonObject(raw.extra || '{}');
  const deleted = extra.deleted === true || extra.deleted === 1 || Boolean(extra.deletetime);
  const quote = extra.quote && typeof extra.quote === 'object' && !Array.isArray(extra.quote) ? extra.quote as Record<string, any> : undefined;
  let text = sourceText(raw.text, 2000);
  if (quote?.text) text = `> in reply to ${String(quote.author || '?')}: ${String(quote.text)}\n${text}`;
  const files = Array.isArray(extra.files) ? extra.files : [];
  return { source: 'teamsrelay', account: email, conversation_id: raw.chat, conversation_title: raw.chat,
    message_id: `${email}/${raw.chat};messageid=${raw.mid}`, sender: String(raw.author || ''), sender_name: String(raw.author || ''), sender_is_me: raw.mine === true || raw.mine === 1,
    sent_at: new Date(Number(raw.mid)).toISOString(), text: deleted ? '' : text,
    attachments: deleted ? [] : files.map((file: any) => ({ name: file && typeof file === 'object' ? String(file.name || file.title || '?') : String(file ?? '?'), size: null })),
    ref: { chat: raw.chat, id: raw.mid, account: email, relay_slot: slot, ...(quote ? { quote } : {}), ...(deleted ? { deleted: true } : {}),
      ...(extra.mentionsMe === true ? { mentions_me: true } : {}) } };
}

// One call per scan: the endpoint reads every active slot store of the token's owner and answers each one's snapshot or error.
export async function readRelay(options: RelayOptions, floor: number, signal?: AbortSignal, input?: RelaySaved): Promise<RelaySnapshot> {
  if (!Number.isSafeInteger(floor) || floor < 0 || !input) throw new SourceError('teamsrelay', 'relay.invalid-argument');
  const maxRows = options.maxRows ?? 10000, maxAccounts = options.maxAccounts ?? 1024;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100000 || !Number.isSafeInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 4096) throw new SourceError('teamsrelay', 'relay.invalid-limit');
  signal?.throwIfAborted();
  let slots: Awaited<ReturnType<RelaySaved>>;
  try { slots = await input(floor, maxRows, signal); }
  catch (error) { if (error instanceof SourceError) throw error; throw new SourceError('teamsrelay', 'relay.app-unavailable'); }
  if (!slots.length) throw new SourceError('teamsrelay', 'relay.no-active-accounts');
  if (slots.length > maxAccounts) throw new SourceError('teamsrelay', 'relay.account-limit');
  const ids = slots.map((entry) => numericSlot(entry.slot));
  if (new Set(ids).size !== ids.length) throw new SourceError('teamsrelay', 'relay.invalid-slot');
  const snapshot: RelaySnapshot = { accounts: [], errors: [] };
  for (const [index, slot] of ids.entries()) {
    signal?.throwIfAborted();
    try {
      const entry = slots[index]!;
      if (typeof entry.snapshot !== 'string') throw new SourceError('teamsrelay', 'relay.store-unavailable');
      const saved = jsonObject(entry.snapshot), state = jsonObject(saved.state), me = jsonObject(state.me || '{}');
      const email = accountNames([me.email])[0]!;
      const scanAt = Number(state.last_scan_ts || 0);
      if (!Number.isSafeInteger(scanAt) || scanAt <= 0) throw new SourceError('teamsrelay', 'relay.scan-state');
      if (!Array.isArray(saved.messages)) throw new SourceError('teamsrelay', 'relay.saved-shape');
      if (saved.messages.length > maxRows) throw new SourceError('teamsrelay', 'relay.result-limit');
      if (!Array.isArray(saved.muted) || saved.muted.some((name: unknown) => typeof name !== 'string' || !name)) throw new SourceError('teamsrelay', 'relay.saved-shape');
      snapshot.accounts.push({ slot, email, scanAt, muted: [...saved.muted as string[]].sort(), messages: saved.messages.map((message: any) => normalize(email, slot, message)) });
    } catch (error) {
      snapshot.errors.push({ code: error instanceof SourceError ? error.code : 'relay.store-unavailable', account: `slot:${slot}` });
    }
  }
  return snapshot;
}
export function createRelayState(since: string, expectedAccounts: string[] = []) {
  return { floor: Date.parse(sourceStamp(since)), accounts: new Set(accountNames(expectedAccounts)), seen: new Map<string, string>(), reported: '', muted: new Map<string, string>() };
}

export async function scanRelay(relay: { snapshot(floor: number, signal?: AbortSignal): Promise<RelaySnapshot> }, state: ReturnType<typeof createRelayState>, emit: Emit, now: () => string = () => new Date().toISOString(), signal?: AbortSignal): Promise<void> {
  const result = await relay.snapshot(state.floor, signal);
  publishAccounts('teamsrelay', state, result.accounts.map((account) => account.email), emit);
  // Before the messages, so a batch of a muted chat never sees it unmuted
  for (const account of result.accounts) {
    const list = JSON.stringify(account.muted);
    if (state.muted.get(account.email) === list) continue;
    emit({ source: 'teamsrelay', account: account.email, muted: account.muted });
    state.muted.set(account.email, list);
  }
  for (const account of result.accounts) for (const message of account.messages) {
    signal?.throwIfAborted();
    if (Date.parse(message.sent_at) >= state.floor) emitChanged(state.seen, message, emit);
  }
  if (result.errors.length || !result.accounts.length) throw new SourceError('teamsrelay', 'relay.scan-incomplete', result.errors[0]?.account, undefined, result.errors[0]?.code ?? 'relay.no-active-accounts');
  // List scans can precede detached body saves. This replay floor never advances.
  emit({ source: 'teamsrelay', checkpoint: new Date(state.floor).toISOString(), coverage: 'saved-history-replay', observed_at: sourceStamp(now()) });
}

export async function relayMain(args = process.argv.slice(2)): Promise<number> {
  const options = watcherArguments(args);
  const saved = httpRelaySaved(oeEndpoint('teamsrelay', 'relay'));
  const state = createRelayState(new Date(Date.parse(options.since) - 120000).toISOString(), options.expectedAccounts);
  return runSource('teamsrelay', options, (signal) => scanRelay({ snapshot: (floor, stop) => readRelay({}, floor, stop, saved) }, state, writeRecord, undefined, signal));
}

if (isEntrypoint(import.meta.url)) void relayMain().then((code) => { process.exitCode = code; }, (error: unknown) => { writeDiagnostic(error, 'teamsrelay'); process.exitCode = 1; });
