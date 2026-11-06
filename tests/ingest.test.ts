import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/dispatcher/config.ts';
import { openDb } from '../src/dispatcher/db.ts';
import * as api from '../src/dispatcher/ingest.ts';
import * as jobs from '../src/dispatcher/jobs.ts';
import * as tickets from '../src/dispatcher/tickets.ts';
import { scratch, snapshot } from './support.ts';

const { ingest, sourceStart } = api;
const AT = '2026-11-06T00:00:00.000000Z';
const SENT = '2026-11-05T23:50:00.123456Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AT));
});
afterEach(() => vi.useRealTimers());

function line(overrides: Record<string, unknown> = {}) {
  return { source: 'outlook', account: 'Me@Example.Invalid', conversation_id: 'C1', conversation_title: 'Deploy',
    message_id: '<Native-ID@x>', sender: 'Bob@Example.Invalid', sender_name: 'Bob', sender_is_me: false,
    sent_at: SENT, text: 'Check RCA-12', attachments: [{ name: 'a.log', size: 3 }], ref: { entry_id: 'E1', store_id: 'S1' }, ...overrides };
}

test('stores source identity, original native ids, metadata and microseconds with its account cursor', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  expect(ingest(db, line({ sent_at: '2026-11-06T01:50:00.123456+02:00' }))).toBe(true);
  expect(db.prepare('SELECT * FROM message').get()).toMatchObject({
    id: 1, source: 'outlook', message_id: '["me@example.invalid","<Native-ID@x>"]', native_id: '<Native-ID@x>',
    sender: 'bob@example.invalid', sender_is_me: 0, sent_at: SENT, stored_at: AT, text: 'Check RCA-12',
    attachments: '[{"name":"a.log","size":3}]', ref: '{"entry_id":"E1","store_id":"S1"}',
  });
  expect(db.prepare('SELECT account,native_id,last_message_at FROM conversation').get()).toEqual({ account: 'Me@Example.Invalid', native_id: 'C1', last_message_at: SENT });
  expect(db.prepare('SELECT email,name FROM person').get()).toEqual({ email: 'bob@example.invalid', name: 'Bob' });
  expect(db.prepare('SELECT * FROM cursor').get()).toEqual({ source: 'outlook', account: 'me@example.invalid', since: SENT });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('unchanged rereads leave every source row, cursor, batch and ingestion time untouched', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  expect(ingest(db, line())).toBe(true);
  const batch = db.prepare("INSERT INTO batch(conversation,state,created_at,outcome) VALUES (1,'done',?,'backlog')").run(AT).lastInsertRowid;
  db.prepare('UPDATE message SET batch=?').run(batch);
  db.prepare("UPDATE message SET sent_at='2026-11-05T23:50:00.123456+00:00'").run();
  const before = snapshot(db, ['conversation', 'person', 'message', 'cursor', 'batch']);
  vi.setSystemTime(new Date('2026-11-06T00:10:00Z'));
  expect(ingest(db, line({ account: 'me@example.invalid', ref: { store_id: 'S1', entry_id: 'E1' } }))).toBe(false);
  expect(snapshot(db, ['conversation', 'person', 'message', 'cursor', 'batch'])).toEqual(before);
});

test('receiving account and source both namespace the native message id', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  expect(ingest(db, line())).toBe(true);
  expect(ingest(db, line({ account: 'other@example.invalid' }))).toBe(true);
  expect(ingest(db, line({ source: 'teams' }))).toBe(true);
  expect(ingest(db, line({ account: 'OTHER@example.invalid' }))).toBe(false);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(3);
  expect(db.prepare('SELECT COUNT(*) AS n FROM conversation').get()?.n).toBe(3);
});

test('edited and deleted source content retains row identity and requeues each changed version', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  expect(ingest(db, line({ source: 'teams' }))).toBe(true);
  const batch = db.prepare("INSERT INTO batch(conversation,state,created_at,outcome) VALUES (1,'done',?,'backlog')").run(AT).lastInsertRowid;
  db.prepare('UPDATE message SET batch=?').run(batch);
  vi.setSystemTime(new Date('2026-11-06T00:01:00Z'));
  expect(ingest(db, line({ source: 'teams', text: 'Cancel RCA-12' }))).toBe(true);
  expect(db.prepare('SELECT id,native_id,text,batch,stored_at FROM message').get()).toEqual({ id: 1, native_id: '<Native-ID@x>', text: 'Cancel RCA-12', batch: null, stored_at: '2026-11-06T00:01:00.000000Z' });
  db.prepare('UPDATE message SET batch=?').run(batch);
  vi.setSystemTime(new Date('2026-11-06T00:02:00Z'));
  const deleted = line({ source: 'teams', text: '', attachments: [], ref: { entry_id: 'E1', store_id: 'S1', deleted: true } });
  expect(ingest(db, deleted)).toBe(true);
  expect(db.prepare('SELECT id,text,ref,batch,stored_at FROM message').get()).toEqual({ id: 1, text: '', ref: '{"entry_id":"E1","store_id":"S1","deleted":true}', batch: null, stored_at: '2026-11-06T00:02:00.000000Z' });
  expect(ingest(db, deleted)).toBe(false);
  expect(db.prepare('SELECT COUNT(*) AS n FROM batch').get()?.n).toBe(1);
});

test('chronological cursor and conversation comparisons preserve mixed legacy UTC formats', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  expect(ingest(db, line())).toBe(true);
  db.prepare("UPDATE cursor SET since='2026-11-06T00:00:00Z'").run();
  db.prepare("UPDATE conversation SET last_message_at='2026-11-06T00:00:00Z'").run();
  expect(ingest(db, line({ message_id: 'later', sent_at: '2026-11-06T00:00:00.000001Z' }))).toBe(true);
  expect(db.prepare('SELECT since FROM cursor').get()?.since).toBe('2026-11-06T00:00:00.000001Z');
  expect(db.prepare('SELECT last_message_at FROM conversation').get()?.last_message_at).toBe('2026-11-06T00:00:00.000001Z');
  expect(ingest(db, line({ message_id: 'earlier', sent_at: '2026-11-06T01:59:59.999999+02:00' }))).toBe(true);
  expect(db.prepare('SELECT since FROM cursor').get()?.since).toBe('2026-11-06T00:00:00.000001Z');
});

test('all conversation, person, message and cursor writes roll back after a late cursor failure', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  db.exec("CREATE TRIGGER reject_cursor BEFORE INSERT ON cursor BEGIN SELECT RAISE(ABORT,'injected cursor failure'); END");
  expect(() => ingest(db, line())).toThrow('injected cursor failure');
  for (const table of ['conversation', 'person', 'message', 'cursor']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
  expect(db.isTransaction).toBe(false);
});

test('a reused source identity cannot silently move to another conversation', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  expect(ingest(db, line())).toBe(true);
  const before = snapshot(db, ['conversation', 'person', 'message', 'cursor']);
  expect(() => ingest(db, line({ conversation_id: 'forged-other-conversation' }))).toThrow(/identity.*conversation/i);
  expect(snapshot(db, ['conversation', 'person', 'message', 'cursor'])).toEqual(before);
});

test.each([
  ['source', null], ['source', ''], ['source', 'unknown-source'], ['account', false], ['account', ' '], ['account', '*'],
  ['conversation_id', 1], ['conversation_id', ''], ['message_id', {}], ['message_id', ''],
  ['sender_is_me', 'false'], ['sender_is_me', 'true'], ['sender_is_me', 0], ['sender_is_me', null], ['sender_is_me', undefined],
  ['sent_at', 1], ['sent_at', '2026-11-06T00:00:00'], ['sent_at', '2026-02-30T00:00:00Z'], ['sent_at', 'Infinity'],
  ['sender', false], ['sender_name', {}], ['text', []], ['conversation_title', 12],
  ['attachments', {}], ['attachments', ['a.log']], ['attachments', [{ name: 1 }]], ['attachments', [{ name: 'a', size: -1 }]],
  ['ref', []], ['ref', null], ['ref', { deleted: 'false' }], ['ref', { nested: NaN }], ['ref', { fn: () => 1 }],
] as const)('rejects invalid %s input atomically (%j)', (field, value) => {
  using db = openDb(scratch('phase3-ingest-').path);
  let error: unknown;
  try { ingest(db, line({ [field]: value })); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(TypeError);
  expect(error).toMatchObject({ code: 'source.invalid-record' });
  expect(String(error)).toContain(field);
  for (const table of ['conversation', 'person', 'message', 'cursor']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
});

test.each([null, [], 'line', 12])('rejects a nonobject watcher record %j', (record) => {
  using db = openDb(scratch('phase3-ingest-').path);
  expect(() => ingest(db, record)).toThrow(/record.*object/i);
});

test('relay attachment null size and arbitrary JSON source metadata remain intact', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  expect(ingest(db, line({ source: 'teamsrelay', attachments: [{ name: 'a.log', size: null }], ref: { chat: 'A', id: '1', relay_slot: 2, custom: ['evidence', { retained: true }] } }))).toBe(true);
  expect(JSON.parse(String(db.prepare('SELECT ref FROM message').get()?.ref))).toEqual({ chat: 'A', id: '1', relay_slot: 2, custom: ['evidence', { retained: true }] });
});

test('initial empty-source floor is durable across reopen', () => {
  const files = scratch('phase3-ingest-');
  const cfg = loadConfig(files.config);
  cfg.start.lookback_minutes = 10;
  {
    using db = openDb(files.path);
    expect(sourceStart(db, cfg, 'outlook')).toBe('2026-11-05T23:50:00.000000Z');
    expect(db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(0);
  }
  vi.setSystemTime(new Date('2026-11-06T01:00:00Z'));
  using reopened = openDb(files.path);
  expect(sourceStart(reopened, cfg, 'outlook')).toBe('2026-11-05T23:50:00.000000Z');
});

test('Teams resumes the chronologically oldest persisted known-account cursor', () => {
  const files = scratch('phase3-ingest-');
  using db = openDb(files.path);
  const cfg = loadConfig(files.config);
  db.exec("INSERT INTO cursor VALUES ('teams','*','2026-11-06T00:00:00Z'),('teams','a@example.invalid','2026-11-05T23:59:00Z'),('teams','b@example.invalid','2026-11-06T00:58:00+01:00')");
  expect(sourceStart(db, cfg, 'teams')).toBe('2026-11-05T23:58:00.000000Z');
});

test('nonrelay catch-up stays capped without rewriting the saved floor or advancing the relay floor', () => {
  const files = scratch('phase3-ingest-');
  using db = openDb(files.path);
  const cfg = loadConfig(files.config);
  db.exec("INSERT INTO cursor VALUES ('teams','*','2026-10-01T00:00:00Z'),('teamsrelay','*','2026-10-01T00:00:00Z')");
  expect(sourceStart(db, cfg, 'teams')).toBe('2026-10-30T00:00:00.000000Z');
  expect(sourceStart(db, cfg, 'teamsrelay')).toBe('2026-10-01T00:00:00.000000Z');
  expect(db.prepare('SELECT since FROM cursor').all()).toEqual([{ since: '2026-10-01T00:00:00Z' }, { since: '2026-10-01T00:00:00Z' }]);
});

test.each(['teams', 'outlook'])('new %s account inventory survives a later read failure and restart', (source) => {
  const files = scratch('phase3-ingest-');
  const cfg = loadConfig(files.config);
  {
    using db = openDb(files.path);
    sourceStart(db, cfg, source, '2026-11-05T23:00:00Z');
    expect(ingest(db, { source, accounts: ['A@example.invalid', 'b@example.invalid'] })).toBe(true);
    expect(() => { throw new Error('later account read failed'); }).toThrow('later account read failed');
  }
  using reopened = openDb(files.path);
  expect(reopened.prepare('SELECT account FROM cursor WHERE source=? ORDER BY account').all(source)).toEqual([{ account: '*' }, { account: 'a@example.invalid' }, { account: 'b@example.invalid' }]);
  const before = snapshot(reopened, ['cursor', 'health']);
  expect(() => ingest(reopened, { source, checkpoint: AT, accounts: ['a@example.invalid'] })).toThrow(/omitted known accounts.*b@example.invalid/);
  expect(snapshot(reopened, ['cursor', 'health'])).toEqual(before);
});

test('a complete checkpoint advances quiet covered accounts for its source only', () => {
  const files = scratch('phase3-ingest-');
  using db = openDb(files.path);
  const cfg = loadConfig(files.config);
  sourceStart(db, cfg, 'teams', SENT);
  sourceStart(db, cfg, 'outlook', SENT);
  ingest(db, { source: 'teams', accounts: ['a@example.invalid', 'b@example.invalid'] });
  expect(ingest(db, { source: 'teams', checkpoint: AT, accounts: ['a@example.invalid', 'B@example.invalid'] })).toBe(true);
  expect(db.prepare("SELECT since FROM cursor WHERE source='teams'").all()).toEqual([{ since: AT }, { since: AT }, { since: AT }]);
  expect(db.prepare("SELECT since FROM cursor WHERE source='outlook'").get()?.since).toBe(SENT);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(0);
});

test('message-level success advances only its account, never the source-wide checkpoint', () => {
  const files = scratch('phase3-ingest-');
  using db = openDb(files.path);
  const cfg = loadConfig(files.config);
  sourceStart(db, cfg, 'outlook', '2026-11-05T23:00:00Z');
  expect(ingest(db, line())).toBe(true);
  expect(db.prepare("SELECT since FROM cursor WHERE source='outlook' AND account='*'").get()?.since).toBe('2026-11-05T23:00:00.000000Z');
});

test.each([
  { source: 'teams', checkpoint: AT },
  { source: 'outlook', checkpoint: AT, accounts: [] },
  { source: 'teams', checkpoint: '2099-01-01T00:00:00Z', accounts: ['a@example.invalid'] },
  { source: 'teams', checkpoint: '2026-11-06T00:00:00', accounts: ['a@example.invalid'] },
  { source: 'teams', accounts: '*' },
  { source: 'teams', accounts: ['*'] },
  { source: 'teams', accounts: [12] },
  { source: 'teams', accounts: [''] },
  { source: 'teams', checkpoint: AT, accounts: ['a@example.invalid'], errors: ['account read failed'] },
  { source: 'teamsrelay', checkpoint: AT, coverage: 'list-scan', observed_at: AT },
  { source: 'teamsrelay', checkpoint: AT, coverage: 'saved-history-replay', observed_at: Infinity },
])('invalid inventory/checkpoint cannot mutate any source state: %j', (record) => {
  using db = openDb(scratch('phase3-ingest-').path);
  expect(() => ingest(db, record)).toThrow();
  expect(db.prepare('SELECT COUNT(*) AS n FROM cursor').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM health').get()?.n).toBe(0);
});

test('inventory requires a durable initial source cursor', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  expect(() => ingest(db, { source: 'teams', accounts: ['a@example.invalid'] })).toThrow(/initial source cursor/);
});

test('relay observation is health only and list-scan time cannot advance its fixed replay floor', () => {
  const files = scratch('phase3-ingest-');
  const cfg = loadConfig(files.config);
  cfg.start.lookback_minutes = 60;
  {
    using db = openDb(files.path);
    expect(sourceStart(db, cfg, 'teamsrelay')).toBe('2026-11-05T23:00:00.000000Z');
    expect(ingest(db, { source: 'teamsrelay', checkpoint: AT, coverage: 'saved-history-replay', observed_at: AT })).toBe(true);
    expect(db.prepare("SELECT since FROM cursor WHERE source='teamsrelay' AND account='*'").get()?.since).toBe('2026-11-05T23:00:00.000000Z');
    expect(JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='teamsrelay'").get()?.detail))).toMatchObject({ observed_at: AT });
  }
  vi.setSystemTime(new Date('2026-11-06T01:00:00Z'));
  using reopened = openDb(files.path);
  expect(sourceStart(reopened, cfg, 'teamsrelay')).toBe('2026-11-05T23:00:00.000000Z');
  expect(ingest(reopened, line({ source: 'teamsrelay', sent_at: '2026-11-05T23:02:00Z', text: 'Body saved after the list scan' }))).toBe(true);
  expect(ingest(reopened, line({ source: 'teamsrelay', sent_at: '2026-11-05T23:02:00Z', text: 'Body saved after the list scan' }))).toBe(false);
  expect(sourceStart(reopened, cfg, 'teamsrelay')).toBe('2026-11-05T23:00:00.000000Z');
});

function enabledFixture() {
  const files = scratch('phase3-batching-');
  const cfg = loadConfig(files.config);
  cfg.tickets.enabled = true;
  cfg.chats.enabled = true;
  return { ...files, cfg };
}

test.each([['outlook', '2026-11-05T23:55:00Z'], ['teams', '2026-11-05T23:58:00Z'], ['teamsrelay', '2026-11-05T23:58:00Z']])(
  '%s observes its full quiet window including a microsecond boundary', (source, sentAt) => {
    const { path, cfg } = enabledFixture();
    using db = openDb(path);
    ingest(db, line({ source, sent_at: sentAt }));
    expect(api.schedule?.(db, cfg, '2026-11-05T23:59:59.999999Z')).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM batch').get()?.n).toBe(0);
    expect(api.schedule?.(db, cfg, AT)).toHaveLength(1);
    expect(db.prepare('SELECT kind,state FROM job').get()).toEqual({ kind: 'triage', state: 'queued' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE batch IS NULL').get()?.n).toBe(0);
    expect(api.schedule?.(db, cfg, AT)).toEqual([]);
  },
);

test('only all-own batches become answered; a mixed batch ending own still needs assessment', () => {
  const { path, cfg } = enabledFixture();
  using db = openDb(path);
  ingest(db, line({ sender_is_me: true }));
  expect(api.schedule?.(db, cfg, AT)).toEqual([]);
  expect(db.prepare('SELECT state,outcome FROM batch').get()).toEqual({ state: 'done', outcome: 'answered' });
  ingest(db, line({ conversation_id: 'C2', message_id: 'question', sent_at: '2026-11-05T23:50:00Z' }));
  ingest(db, line({ conversation_id: 'C2', message_id: 'answer', sender_is_me: true, sent_at: '2026-11-05T23:54:00Z' }));
  expect(api.schedule?.(db, cfg, AT)).toHaveLength(1);
  expect(db.prepare('SELECT state,outcome FROM batch ORDER BY id DESC LIMIT 1').get()).toEqual({ state: 'pending', outcome: 'triage' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE batch=2').get()?.n).toBe(2);
});

test('tickets off leaves input durable without automatic batching, routing or triage', () => {
  const { path, cfg } = enabledFixture();
  cfg.tickets.enabled = false;
  using db = openDb(path);
  ingest(db, line());
  expect(api.schedule?.(db, cfg, AT)).toEqual([]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE batch IS NULL').get()?.n).toBe(1);
  for (const table of ['ticket', 'batch', 'job']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
});

test('chats off retains an active routed batch until chats are enabled', () => {
  const { path, cfg } = enabledFixture();
  cfg.chats.enabled = false;
  using db = openDb(path);
  ingest(db, line());
  const owner = db.prepare("INSERT INTO ticket(title,lifecycle,approved_at,session_id,created_at) VALUES ('Active','active',?,'existing-session',?)").run(AT, AT).lastInsertRowid;
  db.prepare('INSERT INTO ticket_conversation VALUES (?,1,\'primary\',\'you\',?)').run(owner, AT);
  expect(api.schedule?.(db, cfg, AT)).toEqual([]);
  expect(db.prepare('SELECT state,outcome,ticket FROM batch').get()).toEqual({ state: 'pending', outcome: 'routed', ticket: Number(owner) });
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(0);
  cfg.chats.enabled = true;
  expect(api.schedule?.(db, cfg, AT)).toHaveLength(1);
  expect(db.prepare('SELECT kind FROM job').get()?.kind).toBe('forward');
});

test('parked triage absorbs later messages of its conversation without a new job', () => {
  const { path, cfg } = enabledFixture();
  using db = openDb(path);
  ingest(db, line());
  const scheduled = api.schedule?.(db, cfg, AT);
  expect(scheduled).toHaveLength(1);
  jobs.park(db, scheduled[0]!, 'invalid assessment');
  ingest(db, line({ message_id: 'later-own', sender_is_me: true, sent_at: '2026-11-05T23:54:00Z' }));
  expect(api.schedule?.(db, cfg, AT)).toEqual([]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM batch').get()?.n).toBe(1);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE batch=1').get()?.n).toBe(2);
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(1);
  expect(JSON.parse(String(db.prepare('SELECT payload FROM job').get()?.payload)).message_versions).toHaveLength(2);
});

test.each(['queued', 'running'])('a %s triage already owns the conversation; later input stays pending', (state) => {
  const { path, cfg } = enabledFixture();
  using db = openDb(path);
  ingest(db, line());
  expect(api.schedule?.(db, cfg, AT)).toHaveLength(1);
  db.prepare('UPDATE job SET state=?').run(state);
  ingest(db, line({ message_id: 'later', sent_at: '2026-11-05T23:54:00Z' }));
  expect(api.schedule?.(db, cfg, AT)).toEqual([]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE batch IS NULL').get()?.n).toBe(1);
  expect(db.prepare('SELECT COUNT(*) AS n FROM batch').get()?.n).toBe(1);
});

test('batch assignment and enqueue roll back atomically on a job write failure', () => {
  const { path, cfg } = enabledFixture();
  using db = openDb(path);
  ingest(db, line());
  db.exec("CREATE TRIGGER reject_batch_job BEFORE INSERT ON job BEGIN SELECT RAISE(ABORT,'injected batch enqueue failure'); END");
  expect(() => api.schedule?.(db, cfg, AT)).toThrow('injected batch enqueue failure');
  expect(db.prepare('SELECT COUNT(*) AS n FROM batch').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE batch IS NULL').get()?.n).toBe(1);
  expect(db.isTransaction).toBe(false);
});

test('answered messages join the linked ticket timeline and durable next-turn context without a new turn', () => {
  const { path, cfg } = enabledFixture();
  using db = openDb(path);
  ingest(db, line({ sender_is_me: true }));
  const owner = Number(db.prepare("INSERT INTO ticket(title,lifecycle,created_at) VALUES ('Active','active',?)").run(AT).lastInsertRowid);
  db.prepare('INSERT INTO ticket_conversation VALUES (?,1,\'linked\',\'rule\',?)').run(owner, AT);
  expect(api.schedule?.(db, cfg, AT)).toEqual([]);
  expect(db.prepare('SELECT ticket,outcome FROM batch').get()).toEqual({ ticket: owner, outcome: 'answered' });
  expect(db.prepare('SELECT kind,actor,body FROM timeline WHERE kind=\'message\'').get()).toEqual({ kind: 'message', actor: 'you', body: 'Check RCA-12' });
  expect(tickets.ownContext(db, owner)).toMatchObject({ batch_ids: [1], messages: [{ id: 1, sender_is_me: 1 }] });
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(0);
  db.prepare("INSERT INTO turn(ticket,kind,prompt_id,text,session_id,context_ids,created_at) VALUES (?,'forward','context-prompt','Immutable with own reply','session','[1]',?)").run(owner, AT);
  expect(tickets.ownContext(db, owner)).toMatchObject({ batch_ids: [], messages: [] });
  expect(db.prepare('SELECT text,context_ids FROM turn').get()).toEqual({ text: 'Immutable with own reply', context_ids: '[1]' });
  db.prepare("UPDATE turn SET state='cancelled'").run();
  expect(tickets.ownContext(db, owner)).toMatchObject({ batch_ids: [1] });
});

test('an edited own message is new context even when its prior row id was consumed', () => {
  const { path, cfg } = enabledFixture();
  using db = openDb(path);
  ingest(db, line({ sender_is_me: true }));
  const owner = Number(db.prepare("INSERT INTO ticket(title,lifecycle,created_at) VALUES ('Active','active',?)").run(AT).lastInsertRowid);
  db.prepare('INSERT INTO ticket_conversation VALUES (?,1,\'primary\',\'rule\',?)').run(owner, AT);
  expect(api.schedule?.(db, cfg, AT)).toEqual([]);
  db.prepare("INSERT INTO turn(ticket,kind,prompt_id,text,session_id,context_ids,state,created_at) VALUES (?,'forward','old-own','Original own text','session','[1]','done',?)").run(owner, AT);
  vi.setSystemTime(new Date('2026-11-06T00:01:00Z'));
  ingest(db, line({ sender_is_me: true, text: '', ref: { entry_id: 'E1', deleted: true } }));
  expect(api.schedule?.(db, cfg, '2026-11-06T00:01:00Z')).toEqual([]);
  expect(tickets.ownContext(db, owner)).toMatchObject({ batch_ids: [2], messages: [{ id: 1, text: '', ref: '{"entry_id":"E1","store_id":"S1","deleted":true}' }] });
  expect(db.prepare("SELECT body FROM timeline WHERE kind='message' ORDER BY id DESC LIMIT 1").get()?.body).toBe('[Source message deleted]');
  expect(db.prepare('SELECT text FROM turn').get()?.text).toBe('Original own text');
});

test('partial deletion evidence retains source metadata, clears live text and cannot be undone by a stale replay', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  ingest(db, line());
  expect(ingest(db, line({ text: 'stale body returned with the tombstone', ref: { deleted: true } }))).toBe(true);
  const deleted = db.prepare('SELECT * FROM message').get();
  expect(deleted).toMatchObject({ text: '', ref: '{"entry_id":"E1","store_id":"S1","deleted":true}' });
  expect(ingest(db, line())).toBe(false);
  expect(db.prepare('SELECT * FROM message').get()).toEqual(deleted);
});

test('content edits preserve existing source reference fields absent from a partial reread', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  ingest(db, line());
  expect(ingest(db, line({ text: 'Edited', ref: { edit_version: 'v2' } }))).toBe(true);
  expect(JSON.parse(String(db.prepare('SELECT ref FROM message').get()?.ref))).toEqual({ entry_id: 'E1', store_id: 'S1', edit_version: 'v2' });
});

test.each([
  { entry_id: 12 }, { store_id: [] }, { chat: {} }, { id: false }, { account: 12 }, { relay_slot: -1 }, { relay_slot: '2' },
])('rejects malformed known source reference fields: %j', (ref) => {
  using db = openDb(scratch('phase3-ingest-').path);
  expect(() => ingest(db, line({ ref }))).toThrow(/ref/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(0);
});

test('non-JSON attachment metadata and cyclic refs return useful typed source errors', () => {
  using db = openDb(scratch('phase3-ingest-').path);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const record of [line({ ref: cyclic }), line({ attachments: [{ name: 'a.log', unsupported: undefined }] })]) {
    let error: unknown;
    try { ingest(db, record); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ code: 'source.invalid-record' });
    expect(String(error)).toMatch(/ref|attachments/);
  }
  expect(db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(0);
});
