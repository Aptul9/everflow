import { expect, test, vi } from 'vitest';
import { createOutlookState, openOutlook, outlookRecord, outlookSinceFilter, rawOutlookDate, scanOutlook, OutlookEvents } from '../src/watchers/outlook.ts';
import { createComSession } from '../src/windows/com.ts';
import type { OutlookPort } from '../src/watchers/outlook.ts';
import type { SourceRecord } from '../src/watchers/source.ts';
import { ingest, sourceStart } from '../src/dispatcher/ingest.ts';
import { openDb } from '../src/dispatcher/db.ts';

const since = '2026-11-04T10:00:00.000Z';
const now = '2026-11-04T11:00:00.000Z';

function fixtureItem() {
  return {
    Class: 43, ConversationTopic: 'Synthetic topic', Subject: 'Subject', ConversationID: 'conversation', EntryID: 'entry',
    SenderEmailType: 'SMTP', SenderEmailAddress: 'Bob@Example.Invalid', SenderName: 'Bob',
    ReceivedTime: new Date('2026-11-04T10:15:00.000Z'), SentOn: new Date('2026-11-04T10:10:00.000Z'),
    Body: 'Synthetic body', Parent: { StoreID: 'store' }, Attachments: { Count: 1, Item: () => ({ FileName: 'fixture.txt', Size: 42 }) },
    PropertyAccessor: { GetProperty: (name: string) => name.includes('1035001F') ? '<message@example.invalid>' : 'smtp@example.invalid' },
  };
}

function port(accounts = ['a@example.invalid']): OutlookPort {
  return { accounts: () => accounts, read: (_account, _folder, _filter, _visit) => {}, close: () => {} };
}

test('Outlook DASL uses UTC httpmail properties, never locale-dependent Jet dates', () => {
  expect(outlookSinceFilter(false, since)).toBe('@SQL="urn:schemas:httpmail:datereceived" >= \'2026-11-04 10:00\'');
  expect(outlookSinceFilter(true, since)).toBe('@SQL="urn:schemas:httpmail:date" >= \'2026-11-04 10:00\'');
});

test('raw winax dates are reinterpreted from UTC-labelled wall-clock components across DST', () => {
  expect(rawOutlookDate(new Date('2026-01-15T12:30:00Z'), 'Europe/Rome')).toBe('2026-01-15T11:30:00.000Z');
  expect(rawOutlookDate(new Date('2026-07-15T12:30:00Z'), 'Europe/Rome')).toBe('2026-07-15T10:30:00.000Z');
  expect(rawOutlookDate(new Date('2026-03-29T03:15:00Z'), 'Europe/Rome')).toBe('2026-03-29T01:15:00.000Z');
  expect(rawOutlookDate(new Date('2026-10-25T02:15:00Z'), 'Europe/Rome')).toBe('2026-10-25T00:15:00.000Z');
  expect(() => rawOutlookDate(new Date('2026-03-29T02:15:00Z'), 'Europe/Rome')).toThrow(/outlook.invalid-wall-clock/);
});

test('the COM provider attaches existing application, covers mail/meeting/cancel only and releases all item references', () => {
  const rows: SourceRecord[] = [], released: unknown[] = [];
  const items = [43, 53, 54, 55].map((Class) => ({ ...fixtureItem(), Class, EntryID: String(Class), PropertyAccessor: { GetProperty: () => String(Class) } }));
  const restricted = { Count: items.length, Item: (index: number) => items[index - 1] };
  const folder = { Items: { Restrict: () => restricted } };
  const store = { StoreID: 'store', GetDefaultFolder: vi.fn((_kind: number) => { expect(rows[0]).toEqual({ source: 'outlook', accounts: ['a@example.invalid'] }); return folder; }) };
  const nativeAccount = { SmtpAddress: 'a@example.invalid', DeliveryStore: store };
  const namespace = { Accounts: { Count: 1, Item: () => nativeAccount } };
  const app = { GetNamespace: () => namespace };
  const bindings = { initialize: () => 1, uninitialize: vi.fn(), active: () => ({ hresult: 0, pointer: 1n }), queryDispatch: () => ({ hresult: 0, pointer: 2n }),
    releasePointer: vi.fn(), wrapDispatch: () => app, releaseObject: (object: unknown) => { released.push(object); }, points: () => [], pump: () => {} };
  const session = createComSession(bindings), native = openOutlook(session);
  try {
    scanOutlook(native, createOutlookState(since), (row) => { rows.push(row); }, () => now);
    expect(rows.filter((row) => 'message_id' in row).map((row) => row.message_id)).toEqual(['43', '53', '54', '43', '53', '54']);
    expect(store.GetDefaultFolder.mock.calls.map((args) => args[0])).toEqual([6, 5]);
  } finally { native.close(); }
  expect(released).toContain(app); expect(released).toContain(namespace); expect(released).toContain(items[3]);
  expect(bindings.uninitialize).toHaveBeenCalledOnce();
});

test('Outlook normalization retains native refs, attachment metadata, strict own bool and 50000-character body cap', () => {
  const item = fixtureItem();
  item.Body = 'x'.repeat(50_010);
  const released: unknown[] = [];
  const record = outlookRecord(item, 'a@example.invalid', new Set(), false, (object) => { released.push(object); });
  expect(record).toMatchObject({ source: 'outlook', account: 'a@example.invalid', message_id: '<message@example.invalid>',
    sender: 'bob@example.invalid', sender_is_me: false, attachments: [{ name: 'fixture.txt', size: 42 }], ref: { entry_id: 'entry', store_id: 'store' } });
  expect(record.text).toHaveLength(50_000);
  expect(released).toContain(item.PropertyAccessor);
  expect(released).toContain(item.Attachments);
  expect(released).toContain(item.Parent);
  expect(outlookRecord(item, 'a@example.invalid', new Set(), true, () => {}).sender_is_me).toBe(true);
});

test('EX SMTP lookup falls back through MAPI; missing InternetMessageId falls back to EntryID', () => {
  const item = { ...fixtureItem(), SenderEmailType: 'EX', Sender: { GetExchangeUser: () => { throw new Error('unavailable'); } },
    PropertyAccessor: { GetProperty: (name: string) => { if (name.includes('1035001F')) throw new Error('missing'); return 'SMTP@Example.Invalid'; } } };
  expect(outlookRecord(item, 'a@example.invalid', new Set(['smtp@example.invalid']), false, () => {})).toMatchObject({
    message_id: 'entry', sender: 'smtp@example.invalid', sender_is_me: true,
  });
});

test('Outlook body cap counts Unicode characters without cutting surrogate pairs', () => {
  const item = fixtureItem();
  item.Body = '\u{10400}'.repeat(50001);
  expect(Array.from(outlookRecord(item, 'a@example.invalid', new Set(), false, () => {}).text!)).toHaveLength(50000);
});

test('every known account Inbox6 and Sent5 is scanned with two-minute overlap before complete checkpoint', () => {
  const native = port(['a@example.invalid', 'b@example.invalid']);
  const read = vi.fn();
  native.read = read;
  const state = createOutlookState(since);
  const rows: SourceRecord[] = [];
  scanOutlook(native, state, (row) => { rows.push(row); }, () => now);
  expect(rows[0]).toEqual({ source: 'outlook', accounts: ['a@example.invalid', 'b@example.invalid'] });
  expect(read.mock.calls.map((args: unknown[]) => args.slice(0, 3))).toEqual([
    ['a@example.invalid', 6, '@SQL="urn:schemas:httpmail:datereceived" >= \'2026-11-04 09:58\''],
    ['a@example.invalid', 5, '@SQL="urn:schemas:httpmail:date" >= \'2026-11-04 09:58\''],
    ['b@example.invalid', 6, '@SQL="urn:schemas:httpmail:datereceived" >= \'2026-11-04 09:58\''],
    ['b@example.invalid', 5, '@SQL="urn:schemas:httpmail:date" >= \'2026-11-04 09:58\''],
  ]);
  expect(rows.at(-1)).toEqual({ source: 'outlook', checkpoint: now, accounts: ['a@example.invalid', 'b@example.invalid'] });
  expect(state.since).toBe(now);
});

test.each(['folder', 'item'])('failed Outlook %s holds scan checkpoint and preserves inventory', (failure) => {
  const native = port(['a@example.invalid', 'b@example.invalid']);
  native.read = (account, _folder, _filter, visit) => {
    if (account === 'b@example.invalid') {
      if (failure === 'item') visit({ get text() { throw new Error('synthetic unreadable item'); } } as never);
      throw new Error('synthetic unavailable folder');
    }
  };
  const state = createOutlookState(since);
  const rows: SourceRecord[] = [];
  expect(() => scanOutlook(native, state, (row) => { rows.push(row); }, () => now)).toThrow(/outlook/);
  expect(rows[0]).toEqual({ source: 'outlook', accounts: ['a@example.invalid', 'b@example.invalid'] });
  expect(rows.some((row) => 'checkpoint' in row)).toBe(false);
  expect(state.since).toBe(since);
});

test('new Outlook inventory is durable before failing folder reads and missing persisted accounts hold restart', () => {
  using db = openDb(':memory:');
  sourceStart(db, { start: { lookback_minutes: 0 } }, 'outlook', since);
  const native = port(['a@example.invalid', 'b@example.invalid']);
  native.read = () => { throw new Error('synthetic unavailable folder'); };
  expect(() => scanOutlook(native, createOutlookState(since), (row) => { ingest(db, row); }, () => now)).toThrow();
  const known = db.prepare("SELECT account FROM cursor WHERE source='outlook' AND account<>'*' ORDER BY account").all().map((row) => String(row.account));
  expect(known).toEqual(['a@example.invalid', 'b@example.invalid']);
  const rows: SourceRecord[] = [];
  expect(() => scanOutlook(port(), createOutlookState(since, known), (row) => { rows.push(row); }, () => now)).toThrow(/outlook.accounts-incomplete/);
  expect(rows.some((row) => 'checkpoint' in row)).toBe(false);
});

test('Outlook dedupe includes receiving account and changed known content emits again', () => {
  const native = port(['a@example.invalid', 'b@example.invalid']);
  let text = 'Original';
  native.read = (account, folder, _filter, visit) => {
    if (folder === 6) visit({ source: 'outlook', account, conversation_id: 'shared', message_id: 'same', sender_is_me: false, sent_at: since, text, attachments: [], ref: {} });
  };
  const state = createOutlookState(since);
  const rows: SourceRecord[] = [];
  const emit = (row: SourceRecord) => { rows.push(row); };
  scanOutlook(native, state, emit, () => now);
  scanOutlook(native, state, emit, () => now);
  text = 'Edited';
  scanOutlook(native, state, emit, () => now);
  expect(rows.filter((row) => 'message_id' in row).map((row) => [row.account, row.text])).toEqual([
    ['a@example.invalid', 'Original'], ['b@example.invalid', 'Original'], ['a@example.invalid', 'Edited'], ['b@example.invalid', 'Edited'],
  ]);
});

test('NewMailEx keeps pending native IDs with a separate nonsecret count diagnostic', () => {
  const diagnostic = vi.fn();
  const events = new OutlookEvents(diagnostic);
  events.newMail('E1,,E2');
  expect(events.pending).toEqual(['E1', 'E2']);
  expect(diagnostic.mock.calls).toEqual([[{ source: 'outlook', code: 'outlook.newmail', count: 2 }]]);
});
