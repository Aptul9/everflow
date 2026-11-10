import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { utc } from '../dispatcher/time.ts';
import { createKernel, NativeError, spawnedIdentity } from '../windows/kernel.ts';
import type { ProcessIdentity } from '../windows/kernel.ts';
import type { ChildProcess, Serializable } from 'node:child_process';

export type Source = 'outlook' | 'teams' | 'teamsrelay' | 'gchat' | 'gmail' | 'oemail';
export interface SourceMessage {
  source: Source;
  account: string;
  conversation_id: string;
  conversation_title?: string;
  message_id: string;
  sender?: string;
  sender_name?: string;
  sender_is_me: boolean;
  sent_at: string;
  text?: string;
  attachments: { name: string; size?: number | null }[];
  ref: Record<string, any>;
}
export type SourceRecord = SourceMessage | { source: Source; accounts: string[] } | { source: Source; account: string; muted: string[] } | { source: Source; checkpoint: string; accounts?: string[]; coverage?: 'saved-history-replay' | 'recent-topics'; observed_at?: string };
export type Emit = (record: SourceRecord) => void;

export class SourceError extends Error {
  readonly source: Source;
  readonly code: string;
  readonly account: string | undefined;
  readonly status: number | undefined;
  readonly reason: string | undefined;
  constructor(source: Source, code: string, account?: string, status?: number, reason?: string) {
    super(code); this.name = 'SourceError'; this.source = source; this.code = code; this.account = account; this.status = status; this.reason = reason;
  }
}

export function sourceStamp(value: string): string {
  try { return new Date(utc(value)).toISOString(); } catch { throw new TypeError('source.invalid-timestamp'); }
}

export function sourceText(value: unknown, limit: number): string {
  const text = String(value ?? '');
  let units = 0, count = 0;
  for (const character of text) { if (count++ === limit) break; units += character.length; }
  return text.slice(0, units);
}

export function accountNames(values: string[]): string[] {
  if (values.some((value) => typeof value !== 'string' || !value.trim() || value === '*' || /[\r\n\0]/.test(value))) throw new TypeError('source.invalid-account');
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
}

export function publishAccounts(source: Source, state: { accounts: Set<string>; reported: string }, names: string[], emit: Emit): string[] {
  for (const account of accountNames(names)) state.accounts.add(account);
  const accounts = [...state.accounts].sort();
  const serialized = JSON.stringify(accounts);
  if (serialized !== state.reported) { emit({ source, accounts }); state.reported = serialized; }
  return accounts;
}

export function emitChanged(seen: Map<string, string>, record: SourceMessage, emit: Emit): boolean {
  if (!record.message_id || !record.conversation_id || typeof record.sender_is_me !== 'boolean') throw new SourceError(record.source, 'source.invalid-message');
  accountNames([record.account]); sourceStamp(record.sent_at);
  const key = JSON.stringify([record.source, record.account.toLowerCase(), record.message_id]);
  const previous = seen.get(key);
  if (previous?.startsWith('deleted:') && record.ref.deleted !== true) return false;
  const hash = (record.ref.deleted === true ? 'deleted:' : '') + createHash('sha256').update(JSON.stringify(record)).digest('hex');
  if (hash === previous) return false;
  emit(record);
  seen.set(key, hash);
  return true;
}

export function isEntrypoint(url: string, argv: string | undefined = process.argv[1]): boolean {
  if (!argv) return false;
  try {
    const a = resolve(fileURLToPath(url)), b = resolve(argv);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}

export function safeSourceDiagnostic(error: unknown, source: Source): { source: Source; code: string; account?: string; status?: number; reason?: string } {
  if (error instanceof SourceError) return { source: error.source, code: error.code, ...(error.account ? { account: error.account } : {}), ...(error.status === undefined ? {} : { status: error.status }), ...(error.reason === undefined ? {} : { reason: error.reason }) };
  if (error instanceof NativeError) return { source, code: error.code, ...(error.status === undefined ? {} : { status: error.status }) };
  if (error instanceof TypeError && ['source.since-required', 'source.poll', 'source.invalid-timestamp', 'source.invalid-account', 'source.option-required'].includes(error.message)) return { source, code: error.message };
  return { source, code: 'source.unexpected' };
}

export function writeDiagnostic(error: unknown, source: Source): void { process.stderr.write(JSON.stringify(safeSourceDiagnostic(error, source)) + '\n'); }
export function writeRecord(record: SourceRecord): void { process.stdout.write(JSON.stringify(record) + '\n'); }

export function watcherArguments(args: string[], extra: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> = {}): { since: string; once: boolean; poll: number; expectedAccounts: string[]; values: Record<string, any> } {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    since: { type: 'string' }, once: { type: 'boolean' }, poll: { type: 'string' }, 'expected-account': { type: 'string', multiple: true }, ...extra,
  } });
  if (typeof values.since !== 'string' || !values.since) throw new TypeError('source.since-required');
  const poll = values.poll === undefined ? 30 : Number(values.poll);
  if (!Number.isSafeInteger(poll) || poll <= 0 || poll > 86400) throw new TypeError('source.poll');
  return { since: sourceStamp(values.since), once: values.once === true, poll, expectedAccounts: accountNames(values['expected-account'] as string[] ?? []), values };
}

export function requiredOption(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new TypeError('source.option-required');
  return value;
}

function sourceOwner(): boolean { return process.connected === true && process.env.WORKDESK_SOURCE_OWNER === String(process.ppid); }

export interface ChildTracker { owner: ProcessIdentity; capture(pid: number): ProcessIdentity; send(value: unknown): void | Promise<void> }
export async function trackSourceChild(child: ChildProcess, input?: ChildTracker): Promise<void> {
  if (!input && !sourceOwner()) return;
  const owner = input ? { ...input.owner } : (() => { using kernel = createKernel(); return kernel.processIdentity(process.pid); })();
  const capture = input?.capture ?? ((pid: number) => { using kernel = createKernel(); return kernel.processIdentity(pid); });
  const send = input?.send ?? ((value: unknown) => new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) { resolve(); return; }
    process.send(value as Serializable, (error) => { if (error) reject(error); else resolve(); });
  }));
  let expected: ProcessIdentity | undefined;
  const notify = (active: boolean) => {
    if (expected) return send({ type: 'dispatcher.child', pid: expected.pid, identity: { ...expected }, owner, active });
  };
  const exit = Promise.withResolvers<void>();
  const closed = () => exit.resolve();
  child.once('close', closed);
  try {
    expected = await spawnedIdentity(child, capture);
    if (child.exitCode === null && child.signalCode === null) await notify(true);
    await exit.promise;
    await notify(false);
  } catch (error) {
    child.off('close', closed);
    const diagnostic = error instanceof NativeError ? { code: error.code, status: error.status } : { code: 'source.unexpected' };
    try { await send({ type: 'dispatcher.child-error', ...diagnostic }); } finally { throw error; }
  }
}

export async function runSource(source: Source, options: { once: boolean; poll: number }, scan: (signal: AbortSignal) => void | Promise<void>, lifecycle: { wait?: (ms: number, signal: AbortSignal) => Promise<void>; close?: () => void | Promise<void> } = {}, signal?: AbortSignal): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const message = (value: unknown) => { if (value && typeof value === 'object' && 'type' in value && value.type === 'dispatcher.stop') abort(); };
  const owned = sourceOwner();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  process.on('message', message);
  if (owned) process.on('disconnect', abort);
  const stop = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let previous = '';
  try {
    while (!stop.aborted) {
      try { await scan(stop); previous = ''; }
      catch (error) {
        if (stop.aborted) break;
        const diagnostic = JSON.stringify(safeSourceDiagnostic(error, source));
        if (diagnostic !== previous) process.stderr.write(diagnostic + '\n');
        previous = diagnostic;
        if (options.once) return 1;
      }
      if (options.once) return 0;
      try {
        if (lifecycle.wait) await lifecycle.wait(options.poll * 1000, stop);
        else await delay(options.poll * 1000, undefined, { signal: stop });
      } catch (error) { if (!stop.aborted) throw error; }
    }
    return 0;
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    process.off('message', message);
    if (owned) process.off('disconnect', abort);
    try { await lifecycle.close?.(); } finally { if (owned && process.connected) process.disconnect?.(); }
  }
}
