import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/dispatcher/config.ts';
import { openDb } from '../src/dispatcher/db.ts';
import * as ingestApi from '../src/dispatcher/ingest.ts';
import * as jobs from '../src/dispatcher/jobs.ts';
import * as api from '../src/dispatcher/tickets.ts';
import { scratch, snapshot } from './support.ts';

const { ingest } = ingestApi;
const { addRefs, extractRefs } = api;
const AT = '2026-11-06T00:00:00.000000Z';
const OLD = '2026-10-01T00:00:00.000000Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AT));
});
afterEach(() => vi.useRealTimers());

function fixture() {
  const files = scratch('phase3-tickets-');
  const cfg = loadConfig(files.config);
  cfg.tickets.enabled = true;
  cfg.chats.enabled = true;
  cfg.clients = {
    acme: { accounts: ['me@acme.invalid'], domains: ['acme.invalid'], keywords: [] },
    other: { accounts: [], domains: ['other.invalid'], keywords: [] },
  };
  return { ...files, cfg };
}

function ticket(db: DatabaseSync, fields: Record<string, SQLInputValue> = {}): number {
  const values = { title: 'Synthetic ticket', created_at: AT, ...fields };
  return Number(db.prepare(`INSERT INTO ticket(${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`)
    .run(...Object.values(values)).lastInsertRowid);
}

function link(db: DatabaseSync, owner: number, conversation: number, kind = 'primary') {
  db.prepare('INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,?,?,\'rule\',?)').run(owner, conversation, kind, AT);
}

function batch(db: DatabaseSync, overrides: Record<string, unknown> = {}): number {
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM message').get()!.n) + 1;
  const record = { source: 'outlook', account: 'me@acme.invalid', conversation_id: `conversation-${n}`, conversation_title: 'Deploy',
    message_id: `native-${n}`, sender: 'bob@acme.invalid', sender_name: 'Bob', sender_is_me: false,
    sent_at: '2026-11-05T23:50:00.000000Z', text: 'Check RCA-12', ...overrides };
  ingest(db, record);
  const conversation = Number(db.prepare('SELECT id FROM conversation WHERE source=? AND lower(account)=? AND native_id=?')
    .get(record.source, String(record.account).toLowerCase(), record.conversation_id)!.id);
  const id = Number(db.prepare("INSERT INTO batch(conversation,state,created_at,outcome) VALUES (?,'pending',?,'pending')").run(conversation, AT).lastInsertRowid);
  db.prepare('UPDATE message SET batch=? WHERE conversation=? AND batch IS NULL').run(id, conversation);
  return id;
}

function conversation(db: DatabaseSync, id: number) {
  return Number(db.prepare('SELECT conversation FROM batch WHERE id=?').get(id)!.conversation);
}

function inputTurn(db: DatabaseSync, owner: number, state = 'prepared', options: Record<string, SQLInputValue> = {}): number {
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM turn').get()!.n) + 1;
  const values = { ticket: owner, kind: 'forward', prompt_id: `prompt-${n}`, text: 'Immutable input', session_id: `session-${owner}`, state, created_at: AT, ...options };
  return Number(db.prepare(`INSERT INTO turn(${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values)).lastInsertRowid);
}

test.each([
  { lifecycle: 'proposed', report: null, job: null, turn: null, expected: 'Needs you' },
  { lifecycle: 'active', report: 'needs_you', job: 'queued', turn: null, expected: 'Needs you' },
  { lifecycle: 'active', report: 'blocked', job: 'running', turn: null, expected: 'Needs you' },
  { lifecycle: 'proposed', report: 'blocked', job: 'parked', turn: null, expected: 'Failed' },
  { lifecycle: 'done', report: 'done', job: 'parked', turn: null, expected: 'Failed' },
  { lifecycle: 'active', report: 'waiting_them', job: 'queued', turn: null, expected: 'Working' },
  { lifecycle: 'active', report: null, job: 'running', turn: null, expected: 'Working' },
  { lifecycle: 'active', report: null, job: null, turn: 'prepared', expected: 'Working' },
  { lifecycle: 'active', report: null, job: null, turn: 'admitted', expected: 'Working' },
  { lifecycle: 'active', report: null, job: null, turn: 'running', expected: 'Working' },
  { lifecycle: 'active', report: 'waiting_them', job: 'done', turn: 'done', expected: 'Waiting on them' },
  { lifecycle: 'active', report: 'working', job: 'cancelled', turn: 'cancelled', expected: 'Idle' },
  { lifecycle: 'active', report: null, job: null, turn: null, expected: 'Idle' },
  { lifecycle: 'done', report: 'done', job: null, turn: null, expected: 'Done' },
  { lifecycle: 'dismissed', report: null, job: null, turn: null, expected: 'Dismissed' },
] as const)('computed stage follows exact precedence: %j', ({ lifecycle, report, job, turn, expected }) => {
  using db = openDb(fixture().path);
  const owner = ticket(db, { lifecycle, report, report_line: 'Needs attention, please help: free text is not a state' });
  if (job) {
    const id = jobs.enqueue(db, 'forward', 'stage', {}, owner);
    db.prepare('UPDATE job SET state=? WHERE id=?').run(job, id);
  }
  if (turn) inputTurn(db, owner, turn);
  expect(api.stage?.(db, owner)).toBe(expected);
});

test('ticket detail sorts mixed timestamp timeline newest first with deterministic id ties', () => {
  using db = openDb(fixture().path);
  const owner = ticket(db, { lifecycle: 'active' });
  for (const [at, key] of [['2026-11-06T00:00:00Z', 'zero'], ['2026-11-06T00:00:00.000001Z', 'micro'], ['2026-11-06T01:00:00+01:00', 'same-later-id']]) {
    db.prepare("INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (?,?,'comment','you',?,?)").run(owner, at!, key!, key!);
  }
  expect(api.detail?.(db, owner)).toMatchObject({ ticket: { id: owner }, stage: 'Idle', timeline: [{ event_key: 'micro' }, { event_key: 'same-later-id' }, { event_key: 'zero' }] });
});

test.each(['proposed', 'active'])('an existing %s route wins and keeps context links passive', (lifecycle) => {
  using db = openDb(fixture().path);
  const id = batch(db);
  const primary = ticket(db, { lifecycle });
  const context = ticket(db, { lifecycle: 'active', session_id: 'unrelated-context-session' });
  link(db, primary, conversation(db, id));
  link(db, context, conversation(db, id), 'context');
  expect(api.route?.(db, id, AT)).toMatchObject({ ticket: primary, mode: lifecycle === 'proposed' ? 'update' : 'forward', candidates: [], context: [context] });
  expect(db.prepare('SELECT ticket FROM batch WHERE id=?').get(id)?.ticket).toBe(primary);
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
  expect(db.prepare("SELECT COUNT(*) AS n FROM timeline WHERE kind='message' AND ticket=?").get(primary)?.n).toBe(1);
  api.route?.(db, id, AT);
  expect(db.prepare("SELECT COUNT(*) AS n FROM timeline WHERE kind='message' AND ticket=?").get(primary)?.n).toBe(1);
});

test.each(['2026-11-05T00:00:00Z', '2026-10-23T00:00:00Z'])('a done route closed at %s reopens the same approved ticket and session', (closedAt) => {
  using db = openDb(fixture().path);
  const id = batch(db);
  const owner = ticket(db, { lifecycle: 'done', session_id: 'keep-this-session', approved_at: OLD, closed_at: closedAt, report: 'done' });
  link(db, owner, conversation(db, id));
  expect(api.route?.(db, id, AT)).toMatchObject({ ticket: owner, mode: 'forward' });
  expect(db.prepare('SELECT lifecycle,session_id,approved_at,report FROM ticket WHERE id=?').get(owner))
    .toEqual({ lifecycle: 'active', session_id: 'keep-this-session', approved_at: OLD, report: null });
});

test('reopening a manually closed unapproved proposal cannot manufacture approval', () => {
  using db = openDb(fixture().path);
  const id = batch(db);
  const owner = ticket(db, { lifecycle: 'done', closed_at: '2026-11-05T00:00:00Z' });
  link(db, owner, conversation(db, id));
  expect(api.route?.(db, id, AT)).toMatchObject({ ticket: owner, mode: 'update' });
  expect(db.prepare('SELECT lifecycle,approved_at,session_id FROM ticket WHERE id=?').get(owner)).toEqual({ lifecycle: 'proposed', approved_at: null, session_id: null });
});

test.each([
  { lifecycle: 'done', closed_at: '2026-10-22T23:59:59.999999Z' },
  { lifecycle: 'dismissed', closed_at: '2026-11-05T00:00:00Z' },
  { lifecycle: 'done', closed_at: '2026-11-05T00:00:00Z', merged_into: 1 },
])('old done, dismissed and merged tickets become context instead of routing: %j', (fields) => {
  using db = openDb(fixture().path);
  ticket(db);
  const id = batch(db);
  const old = ticket(db, fields);
  link(db, old, conversation(db, id));
  expect(api.route?.(db, id, AT)).toMatchObject({ ticket: null, mode: 'new', context: [old] });
  expect(db.prepare('SELECT kind FROM ticket_conversation WHERE ticket=?').get(old)?.kind).toBe('context');
});

test('a context-only association never routes or borrows its approved session', () => {
  using db = openDb(fixture().path);
  const id = batch(db, { text: 'Unrelated new work' });
  const context = ticket(db, { lifecycle: 'active', approved_at: OLD, session_id: 'context-only' });
  link(db, context, conversation(db, id), 'context');
  expect(api.route?.(db, id, AT)).toEqual({ ticket: null, mode: 'new', candidates: [], context: [context] });
  expect(db.prepare('SELECT ticket FROM batch WHERE id=?').get(id)?.ticket).toBeNull();
});

test.each(['proposed', 'active'])('one shared open reference links by rule and preserves %s assessment mode', (lifecycle) => {
  using db = openDb(fixture().path);
  const id = batch(db);
  const owner = ticket(db, { lifecycle });
  addRefs(db, owner, extractRefs('RCA-12', 'message'), OLD);
  expect(api.route?.(db, id, AT)).toMatchObject({ ticket: owner, mode: lifecycle === 'proposed' ? 'update' : 'forward' });
  expect(db.prepare('SELECT kind,"by" FROM ticket_conversation WHERE ticket=?').get(owner)).toEqual({ kind: 'linked', by: 'rule' });
});

test('multiple shared-reference matches are candidates, never an arbitrary route', () => {
  using db = openDb(fixture().path);
  const id = batch(db);
  const first = ticket(db, { lifecycle: 'active' });
  const second = ticket(db);
  const closed = ticket(db, { lifecycle: 'done' });
  for (const owner of [first, second, closed]) addRefs(db, owner, extractRefs('RCA-12', 'message'), OLD);
  expect(api.route?.(db, id, AT)).toEqual({ ticket: null, mode: 'new', candidates: [first, second], context: [] });
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_conversation').get()?.n).toBe(0);
});

test('account mapping wins over quoted domains; otherwise sender, account and quoted addresses infer clients', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const mapped = batch(db, { text: 'From: person@other.invalid' });
  expect(api.batchClients?.(db, cfg, mapped)).toEqual(['acme']);
  const quoted = batch(db, { account: 'me@personal.invalid', sender: 'A name', text: 'From: Person@Other.Invalid\nPlease check' });
  expect(api.batchClients?.(db, cfg, quoted)).toEqual(['other']);
  const accountDomain = batch(db, { account: 'relay@other.invalid', sender: 'A name', text: 'No addresses here' });
  expect(api.batchClients?.(db, cfg, accountDomain)).toEqual(['other']);
});

test('offered candidates are the union of open same-client, source-local shared people and recent tickets', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db, { text: 'No references' });
  const sameClient = ticket(db, { created_at: OLD, lifecycle: 'active', client: 'acme' });
  const sharedBatch = batch(db, { account: 'other@other.invalid', text: 'No refs' });
  const shared = ticket(db, { created_at: OLD, lifecycle: 'active', client: 'other' });
  link(db, shared, conversation(db, sharedBatch));
  const recent = ticket(db, { created_at: '2026-10-23T00:00:00Z', lifecycle: 'done', client: 'other' });
  const stale = ticket(db, { created_at: OLD, lifecycle: 'active', client: 'other' });
  const offered = api.candidates?.(db, cfg, input, AT);
  expect(offered?.map((item: { id: number }) => item.id).sort()).toEqual([sameClient, shared, recent].sort());
  expect(offered?.find((item: { id: number }) => item.id === shared)).toMatchObject({ shared_people: true });
  expect(offered?.map((item: { id: number }) => item.id)).not.toContain(stale);
});

test('shared person ids across sources are not a verified cross-source identity association', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db, { text: 'No refs' });
  const otherBatch = batch(db, { source: 'teams', account: 'me@other.invalid', text: 'No refs' });
  const other = ticket(db, { created_at: OLD, lifecycle: 'active', client: 'other' });
  link(db, other, conversation(db, otherBatch));
  expect(db.prepare('SELECT COUNT(DISTINCT person) AS n FROM message').get()?.n).toBe(1);
  expect(api.candidates?.(db, cfg, input, AT)).toEqual([]);
});

test('own-message people do not expand the candidate set', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db, { sender_is_me: true, sender: 'me@acme.invalid', text: 'No refs' });
  const oldBatch = batch(db, { sender: 'me@acme.invalid', text: 'No refs' });
  const other = ticket(db, { created_at: OLD, lifecycle: 'active', client: 'other' });
  link(db, other, conversation(db, oldBatch));
  expect(api.candidates?.(db, cfg, input, AT)).toEqual([]);
});

function decision(overrides: Record<string, unknown> = {}) {
  return { on_us: true, reason: 'Explicit request', action: 'new', ticket: null, title: 'Check deployment', client: 'acme',
    summary: 'Deployment needs review', ask: 'Check deployment', proposal: 'Inspect logs', kb_notes: [], confidence: 0.9, ...overrides };
}

function offer(db: DatabaseSync, cfg: ReturnType<typeof loadConfig>, input: number) {
  expect(ingestApi.schedule?.(db, cfg, AT)).toHaveLength(1);
  return db.prepare("SELECT * FROM job WHERE kind='triage' AND json_extract(payload,'$.batch')=? ORDER BY id DESC LIMIT 1").get(input)!;
}

test('a new on-us decision creates a proposed ticket with atomic refs, history and raw log, never a chat', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  offer(db, cfg, input);
  const raw = '{"original":"model response retained verbatim"}';
  expect(api.applyDecision?.(db, input, decision({ raw }))).toBe(1);
  expect(db.prepare('SELECT lifecycle,session_id,approved_at,summary FROM ticket').get()).toEqual({ lifecycle: 'proposed', session_id: null, approved_at: null, summary: 'Deployment needs review' });
  expect(db.prepare('SELECT kind,"by" FROM ticket_conversation').get()).toEqual({ kind: 'primary', by: 'agent' });
  expect(db.prepare('SELECT outcome,ticket FROM batch').get()).toEqual({ outcome: 'proposed', ticket: 1 });
  expect(db.prepare('SELECT reason,raw FROM triage_log').get()).toEqual({ reason: 'Explicit request', raw });
  expect(db.prepare('SELECT key FROM ticket_ref').get()?.key).toBe('RCA-12');
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind IN ('start_chat','forward')").get()?.n).toBe(0);
  expect(api.applyDecision?.(db, input, decision({ raw }))).toBe(1);
  expect(db.prepare('SELECT COUNT(*) AS n FROM triage_log').get()?.n).toBe(1);
});

test('skip retains not_on_us, reason, candidate ids and raw assessment without ticket or chat', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  offer(db, cfg, input);
  const skip = decision({ on_us: false, action: 'skip', reason: 'Newsletter', title: '', raw: 'raw newsletter decision' });
  expect(api.applyDecision?.(db, input, skip)).toBeNull();
  expect(db.prepare('SELECT state,outcome,ticket FROM batch').get()).toEqual({ state: 'done', outcome: 'not_on_us', ticket: null });
  expect(db.prepare('SELECT action,reason,raw,candidates FROM triage_log').get()).toEqual({ action: 'skip', reason: 'Newsletter', raw: 'raw newsletter decision', candidates: '[]' });
  for (const table of ['ticket', 'turn', 'timeline']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
});

test.each([0.75, 0.749999])('agent update at confidence %s respects the linking threshold', (confidence) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db, { text: 'No reference' });
  const candidate = ticket(db, { lifecycle: 'active', client: 'acme', approved_at: OLD, session_id: 'original-session' });
  offer(db, cfg, input);
  const result = api.applyDecision?.(db, input, decision({ action: 'update', ticket: candidate, confidence }));
  if (confidence >= 0.75) {
    expect(result).toBe(candidate);
    expect(db.prepare('SELECT kind,"by" FROM ticket_conversation').get()).toEqual({ kind: 'linked', by: 'agent' });
  } else {
    expect(result).toBe(2);
    expect(db.prepare('SELECT lifecycle,maybe_ticket,approved_at,session_id FROM ticket WHERE id=?').get(result)).toEqual({ lifecycle: 'proposed', maybe_ticket: candidate, approved_at: null, session_id: null });
    expect(db.prepare('SELECT ticket,kind FROM ticket_conversation ORDER BY ticket').all()).toEqual([{ ticket: candidate, kind: 'context' }, { ticket: 2, kind: 'primary' }]);
  }
});

test('a rule-linked proposal gets a fresh assessment instead of bypassing triage', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const owner = ticket(db, { proposal: 'Old proposal' });
  addRefs(db, owner, extractRefs('RCA-12', 'message'), OLD);
  const input = batch(db);
  const offered = offer(db, cfg, input);
  expect(JSON.parse(String(offered.payload))).toMatchObject({ mode: 'update', ticket: owner });
  expect(api.applyDecision?.(db, input, decision())).toBe(owner);
  expect(db.prepare('SELECT proposal,lifecycle FROM ticket WHERE id=?').get(owner)).toEqual({ proposal: 'Inspect logs', lifecycle: 'proposed' });
});

test.each(['forged-id', 'not-offered', 'unknown-client'])('rejects %s at the local decision boundary without partial writes', (invalid) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const unoffered = ticket(db, { created_at: OLD, lifecycle: 'active', client: 'other' });
  const input = batch(db, { text: 'No reference' });
  offer(db, cfg, input);
  const before = snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'triage_log', 'timeline', 'batch']);
  const invalidDecision = invalid === 'unknown-client' ? decision({ client: 'invented-client' })
    : decision({ action: 'update', ticket: invalid === 'forged-id' ? 999999 : unoffered });
  expect(() => api.applyDecision?.(db, input, invalidDecision)).toThrow(/candidate|client/);
  expect(snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'triage_log', 'timeline', 'batch'])).toEqual(before);
});

test.each([
  { on_us: 'false' }, { confidence: NaN }, { confidence: Infinity }, { confidence: 1.1 },
  { action: 'update', ticket: null }, { action: 'skip', on_us: true }, { action: 'new', ticket: 1 }, { on_us: false },
])('rejects malformed or contradictory decisions: %j', (invalid) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  offer(db, cfg, input);
  expect(() => api.applyDecision?.(db, input, decision(invalid))).toThrow();
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM triage_log').get()?.n).toBe(0);
});

test('late assessment rechecks an approved route without rewriting its proposal', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  const owner = ticket(db, { proposal: 'Approved proposal' });
  link(db, owner, conversation(db, input));
  offer(db, cfg, input);
  db.prepare("UPDATE ticket SET lifecycle='active',approved_at=?,session_id='approved-session' WHERE id=?").run(AT, owner);
  expect(api.applyDecision?.(db, input, decision({ proposal: 'Stale replacement' }))).toBe(owner);
  expect(db.prepare('SELECT proposal,lifecycle FROM ticket WHERE id=?').get(owner)).toEqual({ proposal: 'Approved proposal', lifecycle: 'active' });
  expect(db.prepare('SELECT outcome FROM batch').get()?.outcome).toBe('routed');
});

test('late assessment cannot reopen a manual close newer than its source input', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  const owner = ticket(db, { proposal: 'Kept proposal' });
  link(db, owner, conversation(db, input));
  offer(db, cfg, input);
  db.prepare("UPDATE ticket SET lifecycle='done',closed_at='2026-11-06T00:01:00Z',report_at='2026-11-06T00:01:00Z' WHERE id=?").run(owner);
  vi.setSystemTime(new Date('2026-11-06T00:02:00Z'));
  expect(api.applyDecision?.(db, input, decision({ proposal: 'Stale' }))).toBe(owner);
  expect(db.prepare('SELECT lifecycle,proposal FROM ticket WHERE id=?').get(owner)).toEqual({ lifecycle: 'done', proposal: 'Kept proposal' });
  expect(db.prepare('SELECT outcome FROM batch').get()?.outcome).toBe('closed');
});

test('late assessment follows a corrected current route rather than its old proposal target', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  const old = ticket(db, { proposal: 'Old proposal' });
  const target = ticket(db, { lifecycle: 'active', proposal: 'Target proposal' });
  link(db, old, conversation(db, input));
  offer(db, cfg, input);
  db.prepare("UPDATE ticket_conversation SET kind='context' WHERE ticket=?").run(old);
  link(db, target, conversation(db, input), 'linked');
  expect(api.applyDecision?.(db, input, decision({ action: 'update', ticket: old, proposal: 'Stale' }))).toBe(target);
  expect(db.prepare('SELECT proposal FROM ticket WHERE id=?').get(old)?.proposal).toBe('Old proposal');
  expect(db.prepare('SELECT proposal FROM ticket WHERE id=?').get(target)?.proposal).toBe('Target proposal');
});

test('an assessment cannot apply to an edited or deleted input version', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  offer(db, cfg, input);
  ingest(db, { source: 'outlook', account: 'me@acme.invalid', conversation_id: 'conversation-1', message_id: 'native-1', sender: 'bob@acme.invalid', sender_name: 'Bob', sender_is_me: false,
    sent_at: '2026-11-05T23:50:00Z', text: '', ref: { deleted: true } });
  expect(() => api.applyDecision?.(db, input, decision())).toThrow(/input.*changed|version/i);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM triage_log').get()?.n).toBe(0);
  expect(db.prepare('SELECT batch FROM message').get()?.batch).toBeNull();
});

test('decision effects roll back with fenced completion after a late local crash', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  offer(db, cfg, input);
  const job = jobs.claim(db, cfg, 'assessment-worker', AT)!;
  const before = snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'triage_log', 'timeline', 'batch', 'job']);
  expect(() => jobs.complete(db, job, () => {
    api.applyDecision?.(db, input, decision());
    throw new Error('injected decision completion crash');
  })).toThrow('injected decision completion crash');
  expect(snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'triage_log', 'timeline', 'batch', 'job'])).toEqual(before);
  expect(jobs.complete(db, job, () => { api.applyDecision?.(db, input, decision()); })).toBe(true);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n).toBe(1);
  expect(db.prepare('SELECT state FROM job').get()?.state).toBe('done');
});

test.each(['start_chat', 'forward', 'collect', 'prepared', 'admitted', 'running', 'reserved', 'recovery'])(
  'a later ordinary forward is not enqueued around an earlier %s chain', (head) => {
    const { path, cfg } = fixture();
    using db = openDb(path);
    const owner = ticket(db, { lifecycle: 'active', approved_at: OLD, session_id: 'session' });
    if (['prepared', 'admitted', 'running'].includes(head)) inputTurn(db, owner, head);
    else {
      const kind = ['start_chat', 'collect'].includes(head) ? head as 'start_chat' | 'collect' : 'forward';
      const id = jobs.enqueue(db, kind, 'earlier-chain', head === 'recovery' ? { recovery_of: 1 } : {}, owner);
      if (head === 'reserved') db.prepare('UPDATE job SET reserved_at=? WHERE id=?').run(AT, id);
    }
    const input = batch(db);
    link(db, owner, conversation(db, input), 'linked');
    expect(ingestApi.schedule?.(db, cfg, AT)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE key<>'earlier-chain'").get()?.n).toBe(0);
    expect(db.prepare('SELECT state,outcome,ticket FROM batch').get()).toEqual({ state: 'pending', outcome: 'routed', ticket: owner });
  },
);

test('the next eligible forward takes durable waiting batches in FIFO after the collector/recovery chain ends', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const owner = ticket(db, { lifecycle: 'active', approved_at: OLD, session_id: 'session' });
  jobs.enqueue(db, 'forward', 'initial-input', {}, owner);
  const initial = jobs.claim(db, cfg, 'input', AT)!;
  const first = batch(db);
  const second = batch(db);
  link(db, owner, conversation(db, first));
  link(db, owner, conversation(db, second), 'linked');
  expect(jobs.complete(db, initial, () => { jobs.enqueue(db, 'collect', 'collect-chain', {}, owner); })).toBe(true);
  expect(ingestApi.schedule?.(db, cfg, AT)).toEqual([]);
  const collector = jobs.claim(db, cfg, 'collector', AT)!;
  expect(collector.kind).toBe('collect');
  expect(jobs.complete(db, collector, () => { jobs.enqueue(db, 'forward', 'recovery-chain', { recovery_of: 1 }, owner); })).toBe(true);
  expect(ingestApi.schedule?.(db, cfg, AT)).toEqual([]);
  const recovery = jobs.claim(db, cfg, 'recovery', AT)!;
  expect(jobs.complete(db, recovery, () => {})).toBe(true);
  const scheduled = ingestApi.schedule?.(db, cfg, AT);
  expect(scheduled).toHaveLength(1);
  expect(JSON.parse(String(db.prepare('SELECT payload FROM job WHERE id=?').get(scheduled[0]!)?.payload))).toEqual({ batch_ids: [first, second] });
  expect(ingestApi.schedule?.(db, cfg, AT)).toEqual([]);
});

test.each([false, true])('parked forward merging preserves %s prepared input and retains its later tail', (bound) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const owner = ticket(db, { lifecycle: 'active', approved_at: OLD, session_id: 'session' });
  const old = batch(db);
  link(db, owner, conversation(db, old));
  db.prepare("UPDATE batch SET ticket=?,outcome='forward' WHERE id=?").run(owner, old);
  const head = jobs.enqueue(db, 'forward', 'parked-input', { batch_ids: [old] }, owner);
  if (bound) {
    const job = jobs.claim(db, cfg, 'head', AT)!;
    const turn = inputTurn(db, owner, 'prepared', { batch: old });
    expect(jobs.reserveTurn(db, cfg, job, turn, AT)).toBe(true);
  }
  jobs.park(db, head, 'needs reconciliation');
  const later = batch(db);
  link(db, owner, conversation(db, later), 'linked');
  expect(ingestApi.schedule?.(db, cfg, AT)).toEqual([head]);
  const payload = JSON.parse(String(db.prepare('SELECT payload FROM job WHERE id=?').get(head)?.payload));
  expect(payload).toEqual(bound ? { batch_ids: [old], pending_batch_ids: [later] } : { batch_ids: [old, later] });
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE state IN ('queued','running')").get()?.n).toBe(0);
  if (bound) expect(db.prepare('SELECT text,batch FROM turn').get()).toEqual({ text: 'Immutable input', batch: old });
});

test('relink atomically demotes the old route, logs both tickets and reschedules only unprepared future input', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  const from = ticket(db, { lifecycle: 'active', approved_at: OLD, session_id: 'keep-old-chat' });
  const to = ticket(db, { lifecycle: 'active', approved_at: OLD, session_id: 'target-chat' });
  link(db, from, conversation(db, input));
  const oldJob = jobs.enqueue(db, 'forward', 'old-future-input', { batch_ids: [input] }, from);
  db.prepare("UPDATE batch SET ticket=?,outcome='forward' WHERE id=?").run(from, input);
  const payload = db.prepare('SELECT payload FROM job WHERE id=?').get(oldJob)!.payload;
  expect(api.relink?.(db, conversation(db, input), to, AT)).toBe(to);
  expect(db.prepare('SELECT ticket,kind,"by" FROM ticket_conversation ORDER BY ticket').all()).toEqual([
    { ticket: from, kind: 'context', by: 'rule' }, { ticket: to, kind: 'linked', by: 'you' },
  ]);
  expect(db.prepare('SELECT ticket,state,outcome FROM batch').get()).toEqual({ ticket: to, state: 'pending', outcome: 'pending' });
  expect(db.prepare('SELECT ticket,payload,state FROM job WHERE id=?').get(oldJob)).toEqual({ ticket: from, payload, state: 'cancelled' });
  expect(db.prepare("SELECT ticket FROM timeline WHERE actor='you' ORDER BY ticket").all()).toEqual([{ ticket: from }, { ticket: to }]);
  expect(api.relink?.(db, conversation(db, input), to, AT)).toBe(to);
  expect(db.prepare("SELECT COUNT(*) AS n FROM timeline WHERE actor='you'").get()?.n).toBe(2);
  expect(ingestApi.schedule?.(db, cfg, AT)).toHaveLength(1);
  expect(db.prepare("SELECT ticket,kind FROM job WHERE state='queued'").get()).toEqual({ ticket: to, kind: 'forward' });
});

test('relink rolls back both histories, all routes and cancellations after a late write failure', () => {
  const { path } = fixture();
  using db = openDb(path);
  const input = batch(db);
  const from = ticket(db, { lifecycle: 'active' });
  const to = ticket(db);
  link(db, from, conversation(db, input));
  jobs.enqueue(db, 'forward', 'future', { batch_ids: [input] }, from);
  const before = snapshot(db, ['ticket', 'ticket_conversation', 'timeline', 'job', 'batch']);
  db.exec(`CREATE TRIGGER reject_relink_target BEFORE INSERT ON timeline WHEN NEW.ticket=${to} AND NEW.actor='you'
    BEGIN SELECT RAISE(ABORT,'injected relink target history failure'); END`);
  expect(() => api.relink?.(db, conversation(db, input), to, AT)).toThrow('injected relink target history failure');
  expect(snapshot(db, ['ticket', 'ticket_conversation', 'timeline', 'job', 'batch'])).toEqual(before);
  expect(db.isTransaction).toBe(false);
});

test('merge deduplicates refs and links, closes source, retains its chat history and transfers no approval', () => {
  const { path } = fixture();
  using db = openDb(path);
  const first = batch(db);
  const second = batch(db);
  const from = ticket(db, { lifecycle: 'active', approved_at: OLD, session_id: 'historical-chat', report_at: OLD, report_message_id: 'old-report' });
  const to = ticket(db, { proposal: 'Unapproved target proposal' });
  link(db, from, conversation(db, first));
  link(db, to, conversation(db, first), 'context');
  link(db, to, conversation(db, second));
  link(db, from, conversation(db, second), 'context');
  addRefs(db, from, extractRefs('RCA-12 INC0042', 'message'), OLD);
  addRefs(db, to, extractRefs('RCA-12', 'message'), OLD);
  const oldTurn = inputTurn(db, from, 'done', { text: 'Old immutable chat history' });
  db.prepare('UPDATE ticket SET report_turn=? WHERE id=?').run(oldTurn, from);
  const beforeTurn = db.prepare('SELECT * FROM turn WHERE id=?').get(oldTurn);
  expect(api.merge?.(db, from, to, AT)).toBe(to);
  expect(db.prepare('SELECT lifecycle,merged_into,closed_at,report_at,report_turn,report_message_id,session_id FROM ticket WHERE id=?').get(from))
    .toEqual({ lifecycle: 'done', merged_into: to, closed_at: AT, report_at: AT, report_turn: oldTurn, report_message_id: 'old-report', session_id: 'historical-chat' });
  expect(db.prepare('SELECT lifecycle,approved_at,session_id,proposal FROM ticket WHERE id=?').get(to))
    .toEqual({ lifecycle: 'proposed', approved_at: null, session_id: null, proposal: 'Unapproved target proposal' });
  expect(db.prepare('SELECT * FROM turn WHERE id=?').get(oldTurn)).toEqual(beforeTurn);
  expect(db.prepare('SELECT key FROM ticket_ref WHERE ticket=? ORDER BY key').all(to)).toEqual([{ key: 'INC0042' }, { key: 'RCA-12' }]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_ref WHERE ticket=?').get(from)?.n).toBe(2);
  expect(db.prepare('SELECT kind FROM ticket_conversation WHERE ticket=? ORDER BY conversation').all(to)).toEqual([{ kind: 'linked' }, { kind: 'primary' }]);
  expect(db.prepare('SELECT kind FROM ticket_conversation WHERE ticket=?').all(from)).toEqual([{ kind: 'context' }, { kind: 'context' }]);
  expect(api.merge?.(db, from, to, AT)).toBe(to);
  expect(db.prepare("SELECT COUNT(*) AS n FROM timeline WHERE kind='merge'").get()?.n).toBe(2);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='start_chat'").get()?.n).toBe(0);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('merge cancels unprepared source jobs without retargeting payloads or creating an approved target', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  const from = ticket(db, { lifecycle: 'active', approved_at: OLD });
  const to = ticket(db);
  link(db, from, conversation(db, input));
  db.prepare("UPDATE batch SET ticket=?,outcome='forward' WHERE id=?").run(from, input);
  const forward = jobs.enqueue(db, 'forward', 'source-unprepared', { batch_ids: [input] }, from);
  const start = jobs.enqueue(db, 'start_chat', 'source-start', { ticket: from }, from);
  const before = db.prepare('SELECT id,ticket,payload FROM job ORDER BY id').all();
  expect(api.merge?.(db, from, to, AT)).toBe(to);
  expect(db.prepare('SELECT id,ticket,payload FROM job ORDER BY id').all()).toEqual(before);
  expect(db.prepare('SELECT state FROM job WHERE id IN (?,?) ORDER BY id').all(forward, start)).toEqual([{ state: 'cancelled' }, { state: 'cancelled' }]);
  expect(db.prepare('SELECT ticket,state,outcome FROM batch').get()).toEqual({ ticket: to, state: 'pending', outcome: 'pending' });
  expect(ingestApi.schedule?.(db, cfg, AT)).toHaveLength(1);
  expect(db.prepare("SELECT kind,ticket FROM job WHERE state='queued'").get()).toEqual({ kind: 'triage', ticket: to });
});

test('merge rolls back refs, links, source closure and both histories on a late failure', () => {
  using db = openDb(fixture().path);
  const input = batch(db);
  const from = ticket(db, { lifecycle: 'active' });
  const to = ticket(db);
  link(db, from, conversation(db, input));
  addRefs(db, from, extractRefs('RCA-12', 'message'), OLD);
  const before = snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'job', 'batch']);
  db.exec(`CREATE TRIGGER reject_merge_target BEFORE INSERT ON timeline WHEN NEW.ticket=${to} AND NEW.kind='merge'
    BEGIN SELECT RAISE(ABORT,'injected merge target history failure'); END`);
  expect(() => api.merge?.(db, from, to, AT)).toThrow('injected merge target history failure');
  expect(snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'job', 'batch'])).toEqual(before);
});

const rebindCases = ['prepared', 'admitted', 'running', 'reserved-job', 'immutable-job', 'parked-immutable-job', 'unbound-collect', 'done-job-unresolved-turn'] as const;
test.each(rebindCases.flatMap((blocker) => ['source', 'target'].flatMap((side) => ['relink', 'merge'].map((correction) => ({ blocker, side, correction })))))
  ('$correction rejects $side $blocker rather than rebind immutable or unresolved input', ({ blocker, side, correction }) => {
    using db = openDb(fixture().path);
    const input = batch(db);
    const from = ticket(db, { lifecycle: 'active' });
    const to = ticket(db, { lifecycle: 'active' });
    link(db, from, conversation(db, input));
    const owner = side === 'source' ? from : to;
    if (['prepared', 'admitted', 'running'].includes(blocker)) inputTurn(db, owner, blocker, { reserved_at: blocker === 'prepared' ? null : AT });
    else {
      const id = jobs.enqueue(db, blocker === 'unbound-collect' ? 'collect' : 'forward', 'unsafe-target',
        blocker.includes('immutable') ? { prompt_id: 'committed-id', text: 'committed text', session_id: 'immutable-session' } : {}, owner);
      if (blocker === 'reserved-job') db.prepare('UPDATE job SET reserved_at=? WHERE id=?').run(AT, id);
      if (blocker === 'parked-immutable-job') jobs.park(db, id, 'uncertain response');
      if (blocker === 'done-job-unresolved-turn') {
        const turn = inputTurn(db, owner, 'running', { reserved_at: AT });
        db.prepare("UPDATE job SET turn_id=?,state='done' WHERE id=?").run(turn, id);
      }
    }
    const before = snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'turn', 'job', 'batch']);
    expect(() => correction === 'relink' ? api.relink?.(db, conversation(db, input), to, AT) : api.merge?.(db, from, to, AT)).toThrow(/prepared|admitted|running|reserved|immutable|unresolved/i);
    expect(snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'turn', 'job', 'batch'])).toEqual(before);
  });

test('relink transfers only unconsumed answered context; completed immutable turn context stays historical', () => {
  const { path } = fixture();
  using db = openDb(path);
  const consumed = batch(db, { sender_is_me: true });
  const waiting = batch(db, { sender_is_me: true, conversation_id: 'conversation-1', message_id: 'second-own' });
  const from = ticket(db, { lifecycle: 'active' });
  const to = ticket(db, { lifecycle: 'active' });
  link(db, from, conversation(db, consumed));
  db.prepare("UPDATE batch SET ticket=?,state='done',outcome='answered'").run(from);
  inputTurn(db, from, 'done', { context_ids: JSON.stringify([consumed]) });
  expect(api.relink?.(db, conversation(db, consumed), to, AT)).toBe(to);
  expect(api.ownContext?.(db, to)).toMatchObject({ batch_ids: [waiting] });
  expect(db.prepare('SELECT ticket FROM batch WHERE id=?').get(consumed)?.ticket).toBe(from);
  expect(db.prepare('SELECT context_ids FROM turn').get()?.context_ids).toBe(JSON.stringify([consumed]));
});

test('manual close cancels only proven-unadmitted future input and retains admitted/uncertain collectors', () => {
  using db = openDb(fixture().path);
  const future = batch(db);
  const uncertainBatch = batch(db);
  const admittedBatch = batch(db);
  const owner = ticket(db, { lifecycle: 'active', approved_at: OLD, report_at: OLD, report_message_id: 'keep-report-id', report: 'working' });
  for (const input of [future, uncertainBatch, admittedBatch]) link(db, owner, conversation(db, input), input === future ? 'primary' : 'linked');
  db.prepare("UPDATE batch SET ticket=?,outcome='forward'").run(owner);
  const futureJob = jobs.enqueue(db, 'forward', 'future-close', { batch_ids: [future] }, owner);
  const unadmitted = inputTurn(db, owner, 'prepared');
  const safePreparedJob = jobs.enqueue(db, 'forward', 'safe-prepared', {}, owner);
  db.prepare('UPDATE job SET turn_id=? WHERE id=?').run(unadmitted, safePreparedJob);
  const uncertain = inputTurn(db, owner, 'prepared', { batch: uncertainBatch, reserved_at: AT, last_error: 'response lost' });
  const uncertainJob = jobs.enqueue(db, 'forward', 'uncertain-close', { batch_ids: [uncertainBatch] }, owner);
  db.prepare('UPDATE job SET turn_id=?,reserved_at=? WHERE id=?').run(uncertain, AT, uncertainJob);
  jobs.park(db, uncertainJob, 'response lost');
  const admitted = inputTurn(db, owner, 'admitted', { batch: admittedBatch, reserved_at: AT, admitted_at: AT });
  const collector = jobs.enqueue(db, 'collect', 'keep-collector', { turn: admitted }, owner);
  db.prepare('UPDATE ticket SET report_turn=? WHERE id=?').run(admitted, owner);
  expect(api.close?.(db, owner, 'Closed by operator', AT)).toBe(owner);
  expect(db.prepare('SELECT state FROM job WHERE id=?').get(futureJob)?.state).toBe('cancelled');
  expect(db.prepare('SELECT state FROM job WHERE id=?').get(safePreparedJob)?.state).toBe('cancelled');
  expect(db.prepare('SELECT state FROM turn WHERE id=?').get(unadmitted)?.state).toBe('cancelled');
  expect(db.prepare('SELECT state,prompt_id FROM turn WHERE id=?').get(uncertain)).toEqual({ state: 'prepared', prompt_id: 'prompt-2' });
  expect(db.prepare('SELECT state FROM turn WHERE id=?').get(admitted)?.state).toBe('admitted');
  expect(db.prepare('SELECT state FROM job WHERE id=?').get(uncertainJob)?.state).toBe('parked');
  expect(db.prepare('SELECT state FROM job WHERE id=?').get(collector)?.state).toBe('queued');
  expect(db.prepare('SELECT outcome FROM batch WHERE id=?').get(future)?.outcome).toBe('closed');
  expect(db.prepare('SELECT outcome FROM batch WHERE id=?').get(uncertainBatch)?.outcome).toBe('forward');
  expect(db.prepare('SELECT lifecycle,closed_at,report_at,report_turn,report_message_id FROM ticket WHERE id=?').get(owner))
    .toEqual({ lifecycle: 'done', closed_at: AT, report_at: AT, report_turn: admitted, report_message_id: 'keep-report-id' });
  expect(api.close?.(db, owner, 'Closed by operator', AT)).toBe(owner);
  expect(db.prepare("SELECT COUNT(*) AS n FROM timeline WHERE event_key=?").get(`close:ticket:${owner}`)?.n).toBe(1);
});

test('manual close and all future cancellations roll back after a history write failure', () => {
  using db = openDb(fixture().path);
  const owner = ticket(db, { lifecycle: 'active' });
  jobs.enqueue(db, 'forward', 'safe-future', {}, owner);
  const before = snapshot(db, ['ticket', 'timeline', 'turn', 'job', 'batch']);
  db.exec("CREATE TRIGGER reject_close BEFORE INSERT ON timeline WHEN NEW.actor='you' BEGIN SELECT RAISE(ABORT,'injected close failure'); END");
  expect(() => api.close?.(db, owner, 'Reason', AT)).toThrow('injected close failure');
  expect(snapshot(db, ['ticket', 'timeline', 'turn', 'job', 'batch'])).toEqual(before);
});

test.each(['not_on_us', 'backlog', 'answered'])('Make ticket on %s is idempotent and persists feedback across reopen', (outcome) => {
  const { path } = fixture();
  let made: number;
  {
    using db = openDb(path);
    const input = batch(db);
    db.prepare("UPDATE batch SET state='done',outcome=? WHERE id=?").run(outcome, input);
    const beforeSource = snapshot(db, ['cursor', 'conversation', 'message', 'person']);
    made = api.makeTicket?.(db, input, AT);
    expect(made).toBe(1);
    expect(api.makeTicket?.(db, input, AT)).toBe(made);
    expect(db.prepare('SELECT lifecycle,approved_at,session_id FROM ticket').get()).toEqual({ lifecycle: 'proposed', approved_at: null, session_id: null });
    expect(api.feedback?.(db)).toMatchObject({ make_ticket_count: 1, dismiss_count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(0);
    expect(snapshot(db, ['cursor', 'conversation', 'message', 'person'])).toEqual(beforeSource);
  }
  using reopened = openDb(path);
  expect(api.feedback?.(reopened)).toMatchObject({ make_ticket_count: 1, dismiss_count: 0 });
  expect(reopened.prepare('SELECT ticket FROM batch').get()?.ticket).toBe(made!);
});

test('dismiss reason and feedback count persist without a chat and repeated dismissal is idempotent', () => {
  const { path } = fixture();
  let owner: number;
  {
    using db = openDb(path);
    owner = ticket(db);
    expect(api.dismiss?.(db, owner, 'Not our responsibility', AT)).toBe(owner);
    expect(api.dismiss?.(db, owner, 'Not our responsibility', AT)).toBe(owner);
    expect(db.prepare('SELECT lifecycle,closed_at FROM ticket').get()).toEqual({ lifecycle: 'dismissed', closed_at: AT });
    expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(0);
  }
  using reopened = openDb(path);
  expect(api.feedback?.(reopened)).toEqual({ make_ticket_count: 0, dismiss_count: 1, dismiss_reasons: [{ ticket: owner!, reason: 'Not our responsibility', at: AT }] });
});

test('Make ticket uses an existing open route without importing approval from an unrelated context', () => {
  using db = openDb(fixture().path);
  const input = batch(db);
  const owner = ticket(db);
  const context = ticket(db, { lifecycle: 'active', approved_at: OLD, session_id: 'unrelated' });
  link(db, owner, conversation(db, input));
  link(db, context, conversation(db, input), 'context');
  db.prepare("UPDATE batch SET state='done',outcome='answered'").run();
  expect(api.makeTicket?.(db, input, AT)).toBe(owner);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n).toBe(2);
  expect(db.prepare('SELECT approved_at,session_id,lifecycle FROM ticket WHERE id=?').get(owner)).toEqual({ approved_at: null, session_id: null, lifecycle: 'proposed' });
});

test('Make ticket rolls back the proposal, link, refs and feedback after a late history failure', () => {
  using db = openDb(fixture().path);
  const input = batch(db);
  db.prepare("UPDATE batch SET state='done',outcome='backlog'").run();
  const before = snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'triage_log', 'batch']);
  db.exec("CREATE TRIGGER reject_make_feedback BEFORE INSERT ON timeline WHEN NEW.event_key LIKE 'make-ticket:%' BEGIN SELECT RAISE(ABORT,'injected make feedback failure'); END");
  expect(() => api.makeTicket?.(db, input, AT)).toThrow('injected make feedback failure');
  expect(snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'triage_log', 'batch'])).toEqual(before);
});

test('corrections validate ids, existence, terminal targets and reason types with useful errors', () => {
  using db = openDb(fixture().path);
  const input = batch(db);
  const owner = ticket(db);
  const terminal = ticket(db, { lifecycle: 'dismissed' });
  link(db, owner, conversation(db, input));
  expect(() => api.relink?.(db, conversation(db, input), terminal, AT)).toThrow(/terminal|dismissed/);
  expect(() => api.merge?.(db, owner, owner, AT)).toThrow(/itself|same/);
  expect(() => api.merge?.(db, owner, 99999, AT)).toThrow(/not found/);
  expect(() => api.relink?.(db, 99999, owner, AT)).toThrow(/not found/);
  expect(() => api.close?.(db, 99999, '', AT)).toThrow(/not found/);
  expect(() => api.makeTicket?.(db, 99999, AT)).toThrow(/not found/);
  expect(() => api.makeTicket?.(db, input, AT)).toThrow(/skipped|backlog|answered/);
  expect(() => api.close?.(db, owner, false as never, AT)).toThrow(/reason/);
  expect(() => api.relink?.(db, conversation(db, input), 1.5, AT)).toThrow(/id/);
  expect(db.prepare('SELECT lifecycle FROM ticket WHERE id=?').get(owner)?.lifecycle).toBe('proposed');
});

test('a candidate closed after assessment began cannot be reopened by the late agent choice', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db, { text: 'No refs' });
  const candidate = ticket(db, { lifecycle: 'active', approved_at: OLD, client: 'acme' });
  offer(db, cfg, input);
  db.prepare("UPDATE ticket SET lifecycle='done',closed_at='2026-11-06T00:01:00Z',report_at='2026-11-06T00:01:00Z' WHERE id=?").run(candidate);
  vi.setSystemTime(new Date('2026-11-06T00:02:00Z'));
  const created = api.applyDecision(db, input, decision({ action: 'update', ticket: candidate }));
  expect(created).not.toBe(candidate);
  expect(db.prepare('SELECT lifecycle FROM ticket WHERE id=?').get(candidate)?.lifecycle).toBe('done');
  expect(db.prepare('SELECT maybe_ticket,lifecycle FROM ticket WHERE id=?').get(created!)).toEqual({ maybe_ticket: candidate, lifecycle: 'proposed' });
});

test.each(['relink', 'merge'])('%s cancels an unprepared triage without reusing its immutable enqueue key for another target', (correction) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  const source = ticket(db);
  const target = ticket(db);
  link(db, source, conversation(db, input));
  const old = offer(db, cfg, input);
  const payload = old.payload;
  if (correction === 'relink') api.relink(db, conversation(db, input), target, AT);
  else api.merge(db, source, target, AT);
  expect(() => ingestApi.schedule(db, cfg, AT)).not.toThrow();
  expect(db.prepare('SELECT ticket,payload,state FROM job WHERE id=?').get(old.id!)).toEqual({ ticket: source, payload, state: 'cancelled' });
  const fresh = db.prepare("SELECT * FROM job WHERE state='queued' AND kind='triage'").get();
  expect(fresh).toMatchObject({ ticket: target });
  expect(fresh?.key).not.toBe(old.key);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE batch IS NULL').get()?.n).toBe(0);
});

test('relink adopts previously unassigned answered input as next-turn context', () => {
  using db = openDb(fixture().path);
  const input = batch(db, { sender_is_me: true });
  db.prepare("UPDATE batch SET state='done',outcome='answered'").run();
  const target = ticket(db, { lifecycle: 'active' });
  api.relink(db, conversation(db, input), target, AT);
  expect(api.ownContext(db, target)).toMatchObject({ batch_ids: [input], messages: [{ id: 1 }] });
});

test('first automatic association adopts unassigned own-only history without starting a separate turn', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const own = batch(db, { sender_is_me: true, text: 'Earlier own context' });
  db.prepare("UPDATE batch SET state='done',outcome='answered' WHERE id=?").run(own);
  const input = batch(db, { conversation_id: 'conversation-1', message_id: 'new-question' });
  offer(db, cfg, input);
  const owner = api.applyDecision(db, input, decision())!;
  expect(api.ownContext(db, owner)).toMatchObject({ batch_ids: [own], messages: [{ text: 'Earlier own context' }] });
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
});

test('same-clock content edits have distinct message history while a repeated route adds no event', () => {
  using db = openDb(fixture().path);
  const input = batch(db);
  const owner = ticket(db, { lifecycle: 'active' });
  link(db, owner, conversation(db, input));
  api.route(db, input, AT);
  ingest(db, { source: 'outlook', account: 'me@acme.invalid', conversation_id: 'conversation-1', message_id: 'native-1', sender: 'bob@acme.invalid', sender_name: 'Bob', sender_is_me: false,
    sent_at: '2026-11-05T23:50:00Z', text: 'Changed within the same clock tick' });
  const next = Number(db.prepare("INSERT INTO batch(conversation,state,created_at,outcome) VALUES (1,'pending',?,'pending')").run(AT).lastInsertRowid);
  db.prepare('UPDATE message SET batch=? WHERE batch IS NULL').run(next);
  api.route(db, next, AT);
  api.route(db, next, AT);
  expect(db.prepare("SELECT body FROM timeline WHERE kind='message' ORDER BY id").all()).toEqual([{ body: 'Check RCA-12' }, { body: 'Changed within the same clock tick' }]);
});

test('new source history advances activity once; scheduler-style rereads do not postpone idle time', () => {
  using db = openDb(fixture().path);
  const input = batch(db);
  const owner = ticket(db, { lifecycle: 'active', last_activity_at: OLD });
  link(db, owner, conversation(db, input));
  api.route(db, input, AT);
  expect(db.prepare('SELECT last_activity_at FROM ticket WHERE id=?').get(owner)?.last_activity_at).toBe(AT);
  api.route(db, input, '2026-11-06T02:00:00Z');
  expect(db.prepare('SELECT last_activity_at FROM ticket WHERE id=?').get(owner)?.last_activity_at).toBe(AT);
});

test('quiet batching after a manual close cannot turn older ingested input into new work', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  ingest(db, { source: 'outlook', account: 'me@acme.invalid', conversation_id: 'waiting-quiet', message_id: 'before-close',
    sender_is_me: false, sent_at: '2026-11-06T00:00:00Z', text: 'Input already present when closed' });
  const owner = ticket(db, { lifecycle: 'active', approved_at: OLD });
  link(db, owner, 1);
  api.close(db, owner, 'Stop future input', '2026-11-06T00:01:00Z');
  expect(ingestApi.schedule(db, cfg, '2026-11-06T00:10:00Z')).toEqual([]);
  expect(db.prepare('SELECT lifecycle FROM ticket WHERE id=?').get(owner)?.lifecycle).toBe('done');
  expect(db.prepare('SELECT state,outcome FROM batch').get()).toEqual({ state: 'done', outcome: 'closed' });
});

test('a reopened route still suppresses unadmitted input older than its retained manual-close marker', () => {
  using db = openDb(fixture().path);
  const input = batch(db);
  const owner = ticket(db, { lifecycle: 'active', approved_at: OLD, closed_at: '2026-11-06T00:01:00Z', report_at: '2026-11-06T00:01:00Z' });
  link(db, owner, conversation(db, input));
  expect(api.route(db, input, '2026-11-06T00:10:00Z')).toMatchObject({ mode: 'closed', ticket: owner });
  expect(db.prepare('SELECT lifecycle FROM ticket WHERE id=?').get(owner)?.lifecycle).toBe('active');
});

test.each(['close', 'merge', 'relink'])('%s ignores unrelated job payloads while correcting only the selected ticket', (correction) => {
  using db = openDb(fixture().path);
  const input = batch(db);
  const from = ticket(db, { lifecycle: 'active' });
  const to = ticket(db, { lifecycle: 'active' });
  const unrelated = ticket(db, { lifecycle: 'active' });
  link(db, from, conversation(db, input));
  const alien = jobs.enqueue(db, 'forward', 'unrelated-input', { batch_ids: [999999] }, unrelated);
  const maintenance = jobs.enqueue(db, 'sync', 'unrelated-maintenance', { batch: 'not-an-input-batch' }, unrelated);
  const original = db.prepare('SELECT * FROM job ORDER BY id').all();
  expect(() => {
    if (correction === 'close') api.close(db, from, 'Selected ticket only', AT);
    else if (correction === 'merge') api.merge(db, from, to, AT);
    else api.relink(db, conversation(db, input), to, AT);
  }).not.toThrow();
  expect(db.prepare('SELECT * FROM job WHERE id IN (?,?) ORDER BY id').all(alien, maintenance)).toEqual(original);
});

test('Make ticket on already-linked answered input preserves its next-turn context', () => {
  using db = openDb(fixture().path);
  const input = batch(db, { sender_is_me: true, text: 'Own context must survive feedback' });
  const owner = ticket(db, { lifecycle: 'active', approved_at: OLD, session_id: 'existing-session' });
  link(db, owner, conversation(db, input));
  db.prepare("UPDATE batch SET state='done',outcome='answered',ticket=? WHERE id=?").run(owner, input);
  expect(api.makeTicket(db, input, AT)).toBe(owner);
  expect(api.ownContext(db, owner)).toMatchObject({ batch_ids: [input] });
  expect(api.feedback(db).make_ticket_count).toBe(1);
});

test('Make ticket on backlog already routed to an active ticket remains durable forward input', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db);
  const owner = ticket(db, { lifecycle: 'active', approved_at: OLD, closed_at: '2026-11-06T00:01:00Z', session_id: 'existing-session' });
  link(db, owner, conversation(db, input));
  db.prepare("UPDATE batch SET state='done',outcome='backlog' WHERE id=?").run(input);
  expect(api.makeTicket(db, input, '2026-11-06T00:10:00Z')).toBe(owner);
  expect(db.prepare('SELECT state,outcome FROM batch WHERE id=?').get(input)).toEqual({ state: 'pending', outcome: 'routed' });
  expect(ingestApi.schedule(db, cfg, '2026-11-06T00:10:00Z')).toHaveLength(1);
  expect(db.prepare('SELECT lifecycle,approved_at,session_id FROM ticket WHERE id=?').get(owner)).toEqual({ lifecycle: 'active', approved_at: OLD, session_id: 'existing-session' });
});

test('sender display-name addresses still infer only configured client domains', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db, { account: 'me@personal.invalid', sender: 'Display Name <sender@Other.Invalid>', text: 'No quoted address' });
  expect(api.batchClients(db, cfg, input)).toEqual(['other']);
});

test('source-local people shared through a context relation are offered without automatic routing', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const input = batch(db, { text: 'No references' });
  const historical = batch(db, { text: 'No references' });
  const context = ticket(db, { created_at: OLD, client: 'other', lifecycle: 'active', approved_at: OLD });
  link(db, context, conversation(db, historical), 'context');
  expect(api.candidates(db, cfg, input, AT)).toMatchObject([{ id: context, shared_people: true }]);
  expect(api.route(db, input, AT)).toMatchObject({ mode: 'new', ticket: null });
  expect(db.prepare('SELECT approved_at,session_id FROM ticket WHERE id=?').get(context)).toEqual({ approved_at: OLD, session_id: null });
});

const CORRECTION_INPUT = '2026-11-06T01:00:00.123000Z';
const CORRECTION_CLOSED = '2026-11-06T02:00:00.123456+00:00';
const CORRECTION_AT = '2026-11-06T03:00:00.654321Z';

function correctionSource(db: DatabaseSync) {
  const rows = snapshot(db, ['message', 'cursor']);
  return { ...rows, message: rows.message!.map(({ batch: _batch, ...message }) => message) };
}

function correctionMarkers(db: DatabaseSync, owner: number) {
  return db.prepare(`SELECT lifecycle,approved_at,approval_note,session_id,closed_at,report,report_line,report_at,report_turn,report_message_id
    FROM ticket WHERE id=?`).get(owner);
}

function correctionSetup(db: DatabaseSync, cfg: ReturnType<typeof loadConfig>, triage = false, proposedTarget = false) {
  vi.setSystemTime(new Date(CORRECTION_INPUT));
  const oldTarget = batch(db, { text: 'Unrelated target input before its close' });
  const first = batch(db, { conversation_id: 'corrected-conversation', message_id: 'corrected-first', sent_at: '2026-11-05T23:50:00.123456Z', text: 'Transferred first' });
  const inputs = [first];
  if (!triage) inputs.push(batch(db, { conversation_id: 'corrected-conversation', message_id: 'corrected-second', sent_at: '2026-11-05T23:51:00.999999Z', text: 'Transferred second' }));
  const from = ticket(db, { lifecycle: triage ? 'proposed' : 'active', approved_at: triage ? null : OLD, session_id: triage ? null : 'source-session' });
  const target = ticket(db, { lifecycle: proposedTarget ? 'proposed' : 'active', approved_at: proposedTarget ? null : OLD,
    approval_note: proposedTarget ? null : 'Existing approval', session_id: proposedTarget ? null : 'reopened-target-session',
    closed_at: CORRECTION_CLOSED, report_at: CORRECTION_CLOSED, report: 'waiting_them', report_line: 'Retained target report', report_message_id: 'retained-report-id' });
  const reportTurn = inputTurn(db, target, 'done');
  db.prepare('UPDATE ticket SET report_turn=? WHERE id=?').run(reportTurn, target);
  link(db, target, conversation(db, oldTarget));
  link(db, from, conversation(db, first));
  db.prepare('UPDATE batch SET ticket=? WHERE id=?').run(target, oldTarget);
  for (const id of inputs) db.prepare('UPDATE batch SET ticket=?,outcome=? WHERE id=?').run(from, triage ? 'pending' : 'forward', id);
  let originalJob: number;
  if (triage) {
    expect(ingestApi.schedule(db, cfg, CORRECTION_INPUT)).toHaveLength(1);
    originalJob = Number(db.prepare("SELECT id FROM job WHERE kind='triage' AND ticket=?").get(from)!.id);
  } else originalJob = jobs.enqueue(db, 'forward', 'before-correction', { batch_ids: inputs }, from);
  return { from, target, oldTarget, inputs, originalJob, source: correctionSource(db), markers: correctionMarkers(db, target),
    originalPayload: db.prepare('SELECT payload FROM job WHERE id=?').get(originalJob)!.payload,
    turns: snapshot(db, ['turn']) };
}

function correct(db: DatabaseSync, kind: 'relink' | 'merge', state: ReturnType<typeof correctionSetup>) {
  vi.setSystemTime(new Date(CORRECTION_AT));
  return kind === 'relink' ? api.relink(db, conversation(db, state.inputs[0]!), state.target, CORRECTION_AT)
    : api.merge(db, state.from, state.target, CORRECTION_AT);
}

test.each(['relink', 'merge'] as const)('I1 %s preserves transferred FIFO input across reopen without reviving target pre-close input', (kind) => {
  const { path, cfg } = fixture();
  let state: ReturnType<typeof correctionSetup>;
  {
    using db = openDb(path);
    state = correctionSetup(db, cfg);
    expect(correct(db, kind, state)).toBe(state.target);
    expect(correctionSource(db)).toEqual(state.source);
    expect(correctionMarkers(db, state.target)).toEqual(state.markers);
    for (const id of state.inputs) expect(db.prepare('SELECT ticket,state,outcome FROM batch WHERE id=?').get(id))
      .toEqual({ ticket: state.target, state: 'pending', outcome: 'pending' });
  }
  using reopened = openDb(path);
  const scheduled = ingestApi.schedule(reopened, cfg, CORRECTION_AT);
  expect(scheduled).toHaveLength(1);
  expect(reopened.prepare('SELECT ticket,state,outcome FROM batch WHERE id=?').get(state.oldTarget))
    .toEqual({ ticket: state.target, state: 'done', outcome: 'closed' });
  for (const id of state.inputs) expect(reopened.prepare('SELECT ticket,state,outcome FROM batch WHERE id=?').get(id))
    .toEqual({ ticket: state.target, state: 'pending', outcome: 'forward' });
  const job = reopened.prepare('SELECT kind,ticket,payload FROM job WHERE id=?').get(scheduled[0]!)!;
  expect(job).toMatchObject({ kind: 'forward', ticket: state.target });
  expect(JSON.parse(String(job.payload))).toEqual({ batch_ids: state.inputs });
  expect(reopened.prepare('SELECT ticket,state,payload FROM job WHERE id=?').get(state.originalJob))
    .toEqual({ ticket: state.from, state: 'cancelled', payload: state.originalPayload });
  expect(ingestApi.schedule(reopened, cfg, CORRECTION_AT)).toEqual([]);
  expect(reopened.prepare("SELECT COUNT(*) AS n FROM job WHERE state='queued'").get()?.n).toBe(1);
  expect(correctionSource(reopened)).toEqual(state.source);
  expect(correctionMarkers(reopened, state.target)).toEqual(state.markers);
  expect(snapshot(reopened, ['turn'])).toEqual(state.turns);
  expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test.each(['relink', 'merge'] as const)('I1 %s gives corrected triage replacement its own persistent target intent', (kind) => {
  const { path, cfg } = fixture();
  let state: ReturnType<typeof correctionSetup>;
  let replacement: number;
  {
    using db = openDb(path);
    state = correctionSetup(db, cfg, true);
    correct(db, kind, state);
    replacement = Number(db.prepare("SELECT id FROM batch WHERE ticket=? AND state='pending' AND conversation=?")
      .get(state.target, conversation(db, state.inputs[0]!))!.id);
    expect(replacement).not.toBe(state.inputs[0]);
    expect(db.prepare('SELECT ticket,state,outcome FROM batch WHERE id=?').get(state.inputs[0]!))
      .toEqual({ ticket: state.from, state: 'done', outcome: 'corrected' });
    expect(correctionSource(db)).toEqual(state.source);
  }
  using reopened = openDb(path);
  expect(ingestApi.schedule(reopened, cfg, CORRECTION_AT)).toHaveLength(1);
  const job = reopened.prepare("SELECT kind,ticket,payload FROM job WHERE state='queued'").get()!;
  expect(job).toMatchObject({ kind: 'forward', ticket: state.target });
  expect(JSON.parse(String(job.payload))).toEqual({ batch_ids: [replacement] });
  expect(correctionMarkers(reopened, state.target)).toEqual(state.markers);
  expect(correctionSource(reopened)).toEqual(state.source);
  expect(snapshot(reopened, ['turn'])).toEqual(state.turns);
});

test.each(['relink', 'merge'] as const)('I1 %s rolls back intent, transfers and cancellations on a late intent write failure', (kind) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const state = correctionSetup(db, cfg);
  const before = snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'batch', 'message', 'cursor', 'job', 'turn']);
  db.exec(`CREATE TRIGGER reject_correction_intent BEFORE INSERT ON timeline
    WHEN NEW.event_key GLOB 'correction:batch:${state.inputs[1]}:ticket:${state.target}:*'
    BEGIN SELECT RAISE(ABORT,'injected correction intent failure'); END`);
  expect(() => correct(db, kind, state)).toThrow('injected correction intent failure');
  expect(snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'batch', 'message', 'cursor', 'job', 'turn'])).toEqual(before);
  expect(db.isTransaction).toBe(false);
  db.exec('DROP TRIGGER reject_correction_intent');
  expect(correct(db, kind, state)).toBe(state.target);
  expect(ingestApi.schedule(db, cfg, CORRECTION_AT)).toHaveLength(1);
});

test.each(['relink', 'merge'] as const)('I1 %s intent retains a proposed target approval boundary', (kind) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const state = correctionSetup(db, cfg, false, true);
  correct(db, kind, state);
  expect(ingestApi.schedule(db, cfg, CORRECTION_AT)).toHaveLength(2);
  expect(db.prepare("SELECT kind,ticket FROM job WHERE state='queued' ORDER BY id").all())
    .toEqual(state.inputs.map(() => ({ kind: 'triage', ticket: state.target })));
  expect(correctionMarkers(db, state.target)).toEqual(state.markers);
  expect(snapshot(db, ['turn'])).toEqual(state.turns);
});

test.each(['relink', 'merge'] as const)('I1 %s intent belongs only to its transferred batch and selected target', (kind) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const state = correctionSetup(db, cfg);
  correct(db, kind, state);
  const other = ticket(db, { lifecycle: 'active', approved_at: OLD, closed_at: CORRECTION_CLOSED, report_at: CORRECTION_CLOSED });
  const conv = conversation(db, state.inputs[0]!);
  db.prepare("UPDATE ticket_conversation SET kind='context' WHERE conversation=? AND kind IN ('primary','linked')").run(conv);
  link(db, other, conv, 'linked');
  expect(api.route(db, state.inputs[0]!, CORRECTION_AT)).toMatchObject({ ticket: other, mode: 'closed' });
  expect(correctionMarkers(db, state.target)).toEqual(state.markers);
});

test.each(['relink', 'merge'] as const)('I1 %s intent cannot bypass a later target close marker', (kind) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const state = correctionSetup(db, cfg);
  correct(db, kind, state);
  db.prepare("UPDATE ticket SET closed_at='2026-11-06T04:00:00Z',report_at='2026-11-06T04:00:00Z' WHERE id=?").run(state.target);
  expect(ingestApi.schedule(db, cfg, '2026-11-06T05:00:00Z')).toEqual([]);
  for (const id of state.inputs) expect(db.prepare('SELECT state,outcome FROM batch WHERE id=?').get(id)).toEqual({ state: 'done', outcome: 'closed' });
  expect(db.prepare('SELECT closed_at,report_at FROM ticket WHERE id=?').get(state.target))
    .toEqual({ closed_at: '2026-11-06T04:00:00Z', report_at: '2026-11-06T04:00:00Z' });
});
