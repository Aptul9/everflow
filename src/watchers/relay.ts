import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { posix } from 'node:path';
import { accountNames, emitChanged, isEntrypoint, publishAccounts, requiredOption, runSource, sourceStamp, sourceText, SourceError, trackSourceChild, watcherArguments, writeDiagnostic, writeRecord } from './source.ts';
import type { Emit, Source, SourceMessage } from './source.ts';

export interface RelayOptions { host: string; root: string; owner: string; maxRows?: number; maxAccounts?: number; timeoutMs?: number; maxBytes?: number }
export type RelayQuery = (path: string, sql: string, signal?: AbortSignal) => Promise<Record<string, any>[]>;
export type SshSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export interface RelaySnapshot { accounts: { slot: number; email: string; scanAt: number; muted: string[]; messages: SourceMessage[] }[]; errors: { code: string; account: string }[] }
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new SourceError('teamsrelay', 'relay.invalid-argument');
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
export function sqlLiteral(value: string): string {
  if (value.includes('\0')) throw new SourceError('teamsrelay', 'relay.invalid-argument');
  return "'" + value.replaceAll("'", "''") + "'";
}
export function relayCommand(path: string, sql: string): string {
  if (!posix.isAbsolute(path)) throw new SourceError('teamsrelay', 'relay.absolute-path');
  const statement = sql.trimEnd().endsWith(';') ? sql : sql + ';';
  return ['sqlite3', '-readonly', '-json', path, `PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN; ${statement} COMMIT;`].map(shellQuote).join(' ');
}

export async function sshQuery(options: RelayOptions, path: string, sql: string, signal?: AbortSignal, spawnProcess: SshSpawn = spawn): Promise<Record<string, any>[]> {
  const output = await sshRun('teamsrelay', 'relay', options, relayCommand(path, sql), signal, spawnProcess);
  try {
    const value: unknown = JSON.parse(output.toString('utf8'));
    if (!Array.isArray(value) || value.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('shape');
    return value;
  } catch { throw new SourceError('teamsrelay', 'relay.response-json'); }
}

// One owned, bounded SSH command; error codes carry the caller's prefix (relay.timeout, oemail.timeout, ...).
export async function sshRun(source: Source, prefix: string, options: { host: string; timeoutMs?: number; maxBytes?: number }, command: string,
  signal?: AbortSignal, spawnProcess: SshSpawn = spawn): Promise<Buffer> {
  if (!options.host || options.host.startsWith('-') || !/^[a-z0-9_.@:[\]-]+$/i.test(options.host)) throw new SourceError(source, `${prefix}.invalid-host`);
  const timeout = options.timeoutMs ?? 60000, maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new SourceError(source, `${prefix}.invalid-limit`);
  if (signal?.aborted) throw new SourceError(source, `${prefix}.aborted`);
  // host "local": Everflow runs on the OE host itself, so the same command runs in a local bash instead of over SSH
  const local = options.host === 'local';
  if (local && process.platform === 'win32') throw new SourceError(source, `${prefix}.invalid-host`);
  const child = local ? spawnProcess('/bin/bash', ['-c', command], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnProcess('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', options.host, command], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let size = 0, failure: unknown, closed = false, escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (error: unknown) => {
    failure ??= error;
    if (closed) return;
    escalation ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
    child.kill();
  };
  const aborted = () => stop(new SourceError(source, `${prefix}.aborted`));
  const stdout = (bytes: Buffer) => {
    size += bytes.length;
    if (size > maxBytes) stop(new SourceError(source, `${prefix}.result-limit`));
    else if (!failure) chunks.push(Buffer.from(bytes));
  };
  // stderr is drained but never copied into diagnostics or records.
  const stderr = () => {};
  const failed = () => { failure ??= new SourceError(source, `${prefix}.ssh-start`); };
  const exit = new Promise<number | null>((resolve) => {
    child.once('close', (code) => { closed = true; resolve(code); });
  });
  child.stdout?.on('data', stdout); child.stderr?.on('data', stderr); child.once('error', failed);
  const timer = setTimeout(() => stop(new SourceError(source, `${prefix}.timeout`)), timeout);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  try {
    try { if (!closed) await trackSourceChild(child); } catch (error) { stop(error); }
    const code = await exit;
    if (failure !== undefined) throw failure;
    if (code !== 0) throw new SourceError(source, `${prefix}.ssh-failed`, undefined, code ?? undefined);
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer); if (escalation) clearTimeout(escalation);
    signal?.removeEventListener('abort', aborted);
    child.off('error', failed); child.stdout?.off('data', stdout); child.stderr?.off('data', stderr);
  }
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

export async function readRelay(options: RelayOptions, floor: number, signal?: AbortSignal, input?: RelayQuery): Promise<RelaySnapshot> {
  if (!posix.isAbsolute(options.root) || options.root.includes('\0') || !options.owner || !Number.isSafeInteger(floor)) throw new SourceError('teamsrelay', 'relay.invalid-argument');
  const maxRows = options.maxRows ?? 10000, maxAccounts = options.maxAccounts ?? 1024;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100000 || !Number.isSafeInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 4096) throw new SourceError('teamsrelay', 'relay.invalid-limit');
  const query = input ?? ((path, sql, stop) => sshQuery(options, path, sql, stop));
  let slots: Record<string, any>[];
  try {
    signal?.throwIfAborted();
    slots = await query(posix.join(options.root, 'app.db'), `SELECT t.slot FROM teams_accounts t JOIN "user" u ON u.id=t.owner_id WHERE t.stopped=0 AND lower(u.email)=${sqlLiteral(options.owner.toLowerCase())} ORDER BY t.slot LIMIT ${maxAccounts + 1}`, signal);
  } catch { throw new SourceError('teamsrelay', 'relay.app-unavailable'); }
  if (!slots.length) throw new SourceError('teamsrelay', 'relay.no-active-accounts');
  if (slots.length > maxAccounts) throw new SourceError('teamsrelay', 'relay.account-limit');
  const ids = slots.map((row) => numericSlot(row.slot));
  if (new Set(ids).size !== ids.length) throw new SourceError('teamsrelay', 'relay.invalid-slot');
  const snapshot: RelaySnapshot = { accounts: [], errors: [] };
  for (const slot of ids) {
    signal?.throwIfAborted();
    try {
      const rows = await query(posix.join(options.root, String(slot), 'messages.db'), `SELECT json_object('state',json((SELECT json_group_object(k,v) FROM state WHERE k IN ('me','last_scan_ts','state'))),'muted',json((SELECT json_group_array(name) FROM chats WHERE muted=1)),'messages',json((SELECT json_group_array(json_object('chat',chat,'mid',mid,'author',author,'text',text,'mine',mine,'extra',extra)) FROM (SELECT chat,mid,author,substr(text,1,2000) AS text,mine,extra FROM chat_messages WHERE mid GLOB '[0-9]*' AND mid NOT GLOB '*[^0-9]*' AND CAST(mid AS INTEGER)>=${floor} ORDER BY CAST(mid AS INTEGER),chat LIMIT ${maxRows + 1})))) AS snapshot`, signal);
      if (rows.length !== 1) throw new SourceError('teamsrelay', 'relay.saved-shape');
      const saved = jsonObject(rows[0]!.snapshot), state = jsonObject(saved.state), me = jsonObject(state.me || '{}');
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
  const options = watcherArguments(args, { host: { type: 'string' }, 'data-dir': { type: 'string' }, owner: { type: 'string' } });
  const relayOptions: RelayOptions = { host: requiredOption(options.values, 'host'), root: requiredOption(options.values, 'data-dir'), owner: requiredOption(options.values, 'owner') };
  const state = createRelayState(new Date(Date.parse(options.since) - 120000).toISOString(), options.expectedAccounts);
  return runSource('teamsrelay', options, (signal) => scanRelay({ snapshot: (floor, stop) => readRelay(relayOptions, floor, stop) }, state, writeRecord, undefined, signal));
}

if (isEntrypoint(import.meta.url)) void relayMain().then((code) => { process.exitCode = code; }, (error: unknown) => { writeDiagnostic(error, 'teamsrelay'); process.exitCode = 1; });
