import { setTimeout as delay } from 'node:timers/promises';
import { createComSession } from '../windows/com.ts';
import { accountNames, emitChanged, isEntrypoint, publishAccounts, runSource, sourceStamp, sourceText, SourceError, watcherArguments, writeDiagnostic, writeRecord } from './source.ts';
import type { Emit, SourceMessage } from './source.ts';

const INTERNET_ID = 'http://schemas.microsoft.com/mapi/proptag/0x1035001F';
const SENDER_SMTP = 'http://schemas.microsoft.com/mapi/proptag/0x5D01001F';
const KINDS = new Set([43, 53, 54]);

export interface OutlookPort {
  accounts(): string[];
  read(account: string, folder: 5 | 6, filter: string, visit: (record: SourceMessage) => void): void;
  subscribe?(listener: (ids: string) => void): boolean;
  pump?(): void;
  readEvent?(id: string, visit: (record: SourceMessage) => void): void;
  close(): void;
}
export function createOutlookState(since: string, expectedAccounts: string[] = []) {
  return { since: sourceStamp(since), accounts: new Set(accountNames(expectedAccounts)), seen: new Map<string, string>(), reported: '' };
}

export function outlookSinceFilter(sent: boolean, since: string): string {
  return `@SQL="urn:schemas:httpmail:${sent ? 'date' : 'datereceived'}" >= '${sourceStamp(since).slice(0, 16).replace('T', ' ')}'`;
}

export function rawOutlookDate(date: Date, zone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new SourceError('outlook', 'outlook.invalid-wall-clock');
  const wall = date.getTime();
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const represented = (stamp: number) => {
    const parts = Object.fromEntries(format.formatToParts(stamp).map((part) => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  };
  const offsets = new Set([-86_400_000, 0, 86_400_000].map((shift) => represented(wall + shift) - Math.floor((wall + shift) / 1000) * 1000));
  const candidates = [...offsets].map((offset) => wall - offset).filter((stamp) => represented(stamp) === Math.floor(wall / 1000) * 1000);
  if (!candidates.length) throw new SourceError('outlook', 'outlook.invalid-wall-clock');
  // Ambiguous fall-back wall clocks use the first occurrence, matching local Date construction.
  return new Date(Math.min(...candidates)).toISOString();
}

function count(value: unknown, limit: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > limit) throw new SourceError('outlook', 'outlook.collection-limit');
  return number;
}

export function outlookRecord(item: any, account: string, mine: Set<string>, sent: boolean, release: (object: any) => void): SourceMessage {
  const objects = new Set<any>();
  const use = <T>(object: T): T => { if (object && (typeof object === 'object' || typeof object === 'function')) objects.add(object); return object; };
  try {
    const accessor = use(item.PropertyAccessor);
    const property = (name: string): string => { try { return String(accessor.GetProperty(name) ?? ''); } catch { return ''; } };
    let sender = '';
    if (String(item.SenderEmailType) === 'EX') {
      try { const exchange = use(use(item.Sender).GetExchangeUser()); sender = String(exchange?.PrimarySmtpAddress ?? ''); } catch { /* MAPI fallback below. */ }
      if (!sender) sender = property(SENDER_SMTP);
    }
    sender = (sender || String(item.SenderEmailAddress ?? '')).toLowerCase();
    const messageId = property(INTERNET_ID) || String(item.EntryID ?? '');
    const topic = String(item.ConversationTopic || item.Subject || '');
    const attachments = use(item.Attachments), metadata: SourceMessage['attachments'] = [];
    for (let index = 1, total = count(attachments.Count, 10000); index <= total; index++) {
      const attachment = use(attachments.Item(index));
      metadata.push({ name: String(attachment.FileName || '?'), size: count(attachment.Size, Number.MAX_SAFE_INTEGER) });
    }
    const parent = use(item.Parent);
    return { source: 'outlook', account: account.toLowerCase(), conversation_id: String(item.ConversationID || 'topic:' + topic), conversation_title: topic,
      message_id: messageId, sender, sender_name: String(item.SenderName || ''), sender_is_me: Boolean(sent || mine.has(sender)),
      sent_at: rawOutlookDate(sent ? item.SentOn : item.ReceivedTime), text: sourceText(item.Body || '', 50000), attachments: metadata,
      ref: { entry_id: String(item.EntryID), store_id: String(parent.StoreID) } };
  } finally {
    let failed = false;
    for (const object of [...objects].reverse()) { try { release(object); } catch { failed = true; } }
    if (failed) throw new SourceError('outlook', 'outlook.reference-cleanup', account);
  }
}

export function scanOutlook(port: OutlookPort, state: ReturnType<typeof createOutlookState>, emit: Emit, now: () => string = () => new Date().toISOString(), signal?: AbortSignal): void {
  const began = sourceStamp(now());
  let active: string[];
  try { active = accountNames(port.accounts()); }
  catch { publishAccounts('outlook', state, [], emit); throw new SourceError('outlook', 'outlook.accounts-unavailable'); }
  const expected = publishAccounts('outlook', state, active, emit);
  if (!active.length || expected.some((name) => !active.includes(name))) throw new SourceError('outlook', 'outlook.accounts-incomplete');
  for (const account of active) {
    try {
      for (const folder of [6, 5] as const) {
        signal?.throwIfAborted();
        port.read(account, folder, outlookSinceFilter(folder === 5, new Date(Date.parse(state.since) - 120000).toISOString()), (record) => {
          if (record.account !== account) throw new SourceError('outlook', 'outlook.account-mismatch', account);
          emitChanged(state.seen, record, emit);
        });
      }
    } catch { throw new SourceError('outlook', 'outlook.read-failed', account); }
  }
  emit({ source: 'outlook', checkpoint: began, accounts: expected });
  state.since = began;
}

export class OutlookEvents {
  pending: string[] = [];
  private readonly diagnostic: (record: { source: string; code: string; count: number }) => void;
  constructor(diagnostic: (record: { source: string; code: string; count: number }) => void) { this.diagnostic = diagnostic; }
  newMail(ids: string): void {
    if (ids.length > 1_048_576) { this.diagnostic({ source: 'outlook', code: 'outlook.event-overflow', count: 0 }); return; }
    const entries = ids.split(',').filter(Boolean);
    this.pending.push(...entries.slice(0, Math.max(0, 4096 - this.pending.length)));
    if (entries.length) this.diagnostic({ source: 'outlook', code: 'outlook.newmail', count: entries.length });
  }
}

export function openOutlook(session: ReturnType<typeof createComSession> = createComSession()): OutlookPort {
  try {
    const attached = session.attachOutlook();
    if (!attached.object) throw new SourceError('outlook', 'outlook.not-running', undefined, 0x800401e3);
    const namespace = session.track(attached.object.GetNamespace('MAPI'));
    const accounts = new Map<string, any>(), stores = new Map<string, string>();
    const release = (object: any) => { session.track(object); session.release(object); };
    return {
      accounts() {
        for (const account of accounts.values()) session.release(account);
        accounts.clear(); stores.clear();
        using scope = session.scope();
        const collection = scope.use(namespace.Accounts);
        for (let index = 1, total = count(collection.Count, 1024); index <= total; index++) {
          const account = session.track(collection.Item(index));
          const address = accountNames([String(account.SmtpAddress ?? '')])[0]!;
          if (accounts.has(address)) { session.release(account); throw new SourceError('outlook', 'outlook.duplicate-account'); }
          accounts.set(address, account);
        }
        return [...accounts.keys()];
      },
      read(account, kind, filter, visit) {
        using scope = session.scope();
        const store = scope.use(accounts.get(account).DeliveryStore);
        const folder = scope.use(store.GetDefaultFolder(kind));
        stores.set(String(store.StoreID), account);
        const collection = scope.use(scope.use(folder.Items).Restrict(filter));
        for (let index = 1, total = count(collection.Count, 100000); index <= total; index++) {
          using itemScope = session.scope();
          const item = itemScope.use(collection.Item(index));
          if (KINDS.has(Number(item.Class))) visit(outlookRecord(item, account, new Set(accounts.keys()), kind === 5, release));
        }
      },
      readEvent(id, visit) {
        using scope = session.scope();
        const item = scope.use(namespace.GetItemFromID(id));
        const account = stores.get(String(scope.use(item.Parent).StoreID));
        if (account && KINDS.has(Number(item.Class))) visit(outlookRecord(item, account, new Set(accounts.keys()), false, release));
      },
      subscribe: (listener) => session.subscribeNewMail(attached.object, listener), pump: () => session.pump(), close: () => session.close(),
    };
  } catch (error) { session.close(); throw error; }
}

export async function outlookMain(args = process.argv.slice(2)): Promise<number> {
  const options = watcherArguments(args);
  if (options.values.poll === undefined) options.poll = 60;
  const state = createOutlookState(options.since, options.expectedAccounts);
  const events = new OutlookEvents((record) => { process.stderr.write(JSON.stringify(record) + '\n'); });
  let port: OutlookPort | undefined;
  return runSource('outlook', options, (signal) => {
    try {
      if (!port) { port = openOutlook(); if (!options.once) port.subscribe?.((ids) => events.newMail(ids)); }
      scanOutlook(port, state, writeRecord, undefined, signal);
    } catch (error) { port?.close(); port = undefined; throw error; }
  }, {
    close: () => { port?.close(); port = undefined; },
    wait: async (ms, signal) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !signal.aborted) {
        port?.pump?.();
        for (const id of events.pending.splice(0)) {
          try { port?.readEvent?.(id, (record) => { emitChanged(state.seen, record, writeRecord); }); }
          catch { writeDiagnostic(new SourceError('outlook', 'outlook.event-read-failed'), 'outlook'); }
        }
        await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal });
      }
    },
  });
}

if (isEntrypoint(import.meta.url)) void outlookMain().then((code) => { process.exitCode = code; }, (error: unknown) => { writeDiagnostic(error, 'outlook'); process.exitCode = 1; });
