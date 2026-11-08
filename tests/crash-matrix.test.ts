import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as chat from '../src/dispatcher/chat.ts';
import { openDb } from '../src/dispatcher/db.ts';
import { ingest, schedule } from '../src/dispatcher/ingest.ts';
import * as jobs from '../src/dispatcher/jobs.ts';
import { handleTriage } from '../src/dispatcher/kb-agent.ts';
import { connect } from '../src/dispatcher/opencode.ts';
import { close } from '../src/dispatcher/tickets.ts';
import { AT, addBatch, chatFixture, claimed, proposed, row } from './chat-support.ts';
import { decision, kbFixture, provider, scriptedPeer as kbPeer, text } from './kb-support.ts';
import { PEER_AT, remoteSession, scriptedPeer } from './opencode-support.ts';
import { snapshot } from './support.ts';

type Peer = Awaited<ReturnType<typeof scriptedPeer>>;
type Tag = { store_id?: unknown; ticket?: unknown } | undefined;

beforeEach(() => { vi.stubEnv('WORKDESK_OPENCODE_PASSWORD', ''); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT)); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

const source = ['message', 'conversation', 'cursor'];
const tag = (session: { metadata?: unknown }) => (session.metadata as { workdesk?: Tag } | undefined)?.workdesk;
const store = (db: DatabaseSync) => JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()!.detail)).store_id as string;
const prompts = (peer: Peer) => peer.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/prompt'));
const count = (db: DatabaseSync, sql: string, ...values: (string | number)[]) => Number(db.prepare(sql).get(...values)!.n);
const retryAt = (db: DatabaseSync, job: number) => vi.setSystemTime(new Date(String(row(db, 'job', job).next_at)));

// G10: durable effects and retained peer records, checked after each crash chain.
function invariants(db: DatabaseSync, peer: Peer) {
  expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const own = store(db), sessions = new Map<number, number>();
  for (const session of peer.sessions.values()) {
    const value = tag(session);
    if (value?.store_id === own) sessions.set(Number(value.ticket), (sessions.get(Number(value.ticket)) ?? 0) + 1);
  }
  for (const [ticket, n] of sessions) expect(n, `tagged sessions for ticket ${ticket}`).toBe(1);
  for (const owner of db.prepare('SELECT id,session_id,approved_at FROM ticket WHERE session_id IS NOT NULL').all()) {
    expect(owner.approved_at, `session target without approval on ticket ${owner.id}`).not.toBeNull();
    const value = peer.sessions.get(String(owner.session_id)) && tag(peer.sessions.get(String(owner.session_id))!);
    if (value) expect(value).toMatchObject({ store_id: own, ticket: owner.id });
  }
  const posts = prompts(peer);
  for (const turn of db.prepare('SELECT prompt_id,text,session_id FROM turn').all()) {
    const sent = posts.filter((call) => call.body.id === turn.prompt_id);
    expect(sent.length, `POSTs for ${turn.prompt_id}`).toBeLessThanOrEqual(1);
    for (const call of sent) {
      expect(call.body.text).toBe(turn.text);
      expect(decodeURIComponent(call.url.pathname)).toBe(`/api/session/${turn.session_id}/prompt`);
    }
  }
  expect(count(db, "SELECT COUNT(*) AS n FROM batch WHERE state='done' AND outcome IS NULL")).toBe(0);
  expect(count(db, "SELECT COUNT(*) AS n FROM turn WHERE state NOT IN ('prepared','admitted','running','done','cancelled')")).toBe(0);
  expect(count(db, "SELECT COUNT(*) AS n FROM ticket WHERE lifecycle NOT IN ('proposed','active','done','dismissed')")).toBe(0);
  expect(count(db, "SELECT COUNT(*) AS n FROM job WHERE state='done' AND (lease_token IS NOT NULL OR run_id IS NOT NULL)")).toBe(0);
  expect(count(db, "SELECT COUNT(*) AS n FROM job WHERE state='running' AND (lease_token IS NULL OR lease_until IS NULL)")).toBe(0);
}

function approvedSession(db: DatabaseSync, peer: Peer, cfg: ReturnType<typeof chatFixture>['cfg'], fields: Record<string, string> = {}) {
  const ticket = proposed(db, { lifecycle: 'active', approved_at: AT, approval_note: '', session_id: 'ses_1', ...fields });
  peer.sessions.set('ses_1', remoteSession('ses_1', cfg.opencode.directory, { workdesk: { store_id: store(db), ticket } }));
  return ticket;
}

test('G3 two stores with the same numeric ticket keep separate tagged sessions across lost create and reopen', async () => {
  await using peer = await scriptedPeer();
  const a = chatFixture(peer.url), b = chatFixture(peer.url);
  b.cfg.opencode.directory = a.cfg.opencode.directory;
  let first: number, second: number;
  {
    using db = openDb(a.path);
    first = proposed(db); addBatch(db, first); chat.approve(a.cfg, db, first, 'Store A');
    await chat.startChat(a.cfg, db, claimed(db, a.cfg));
  }
  {
    using db = openDb(b.path);
    second = proposed(db); addBatch(db, second); chat.approve(b.cfg, db, second, 'Store B');
    peer.state.loseCreate = true;
    await chat.startChat(b.cfg, db, claimed(db, b.cfg));
    expect(row(db, 'ticket', second).session_id).toBeNull();
    retryAt(db, Number(db.prepare("SELECT id FROM job WHERE kind='start_chat'").get()!.id));
  }
  expect(second).toBe(first);
  using reopened = openDb(b.path);
  await chat.startChat(b.cfg, reopened, claimed(reopened, b.cfg, 'store-b-reopened'), { peer: connect(b.cfg) });
  using original = openDb(a.path);
  expect(peer.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session')).toHaveLength(2);
  const targets = [row(original, 'ticket', first).session_id, row(reopened, 'ticket', second).session_id];
  expect(new Set(targets).size).toBe(2);
  expect(tag(peer.sessions.get(String(targets[0]))!)).toMatchObject({ store_id: store(original), ticket: first });
  expect(tag(peer.sessions.get(String(targets[1]))!)).toMatchObject({ store_id: store(reopened), ticket: second });
  expect(store(original)).not.toBe(store(reopened));
  expect(prompts(peer)).toHaveLength(2);
  invariants(original, peer); invariants(reopened, peer);
});

test('G3 late preparation fault after session save leaves no turn, then the reopened job reuses that session once', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let ticket: number, job: number, before: ReturnType<typeof snapshot>;
  {
    using db = openDb(path);
    ticket = proposed(db); addBatch(db, ticket); chat.approve(cfg, db, ticket, '');
    before = snapshot(db, ['batch', ...source]);
    db.exec("CREATE TRIGGER g3_prepare BEFORE UPDATE OF state ON batch WHEN NEW.state='prepared' BEGIN SELECT RAISE(ABORT,'g3 injected preparation fault'); END");
    const claim = claimed(db, cfg); job = claim.id;
    await chat.startChat(cfg, db, claim);
    expect(count(db, 'SELECT COUNT(*) AS n FROM turn')).toBe(0);
    expect(snapshot(db, ['batch', ...source])).toEqual(before);
    expect(row(db, 'ticket', ticket).session_id).toBe('ses_1');
    expect(row(db, 'job', job)).toMatchObject({ state: 'queued', turn_id: null });
    expect(String(row(db, 'job', job).last_error)).toContain('g3 injected preparation fault');
    expect(prompts(peer)).toHaveLength(0);
    retryAt(db, job);
  }
  using db = openDb(path);
  db.exec('DROP TRIGGER g3_prepare');
  const retry = claimed(db, cfg, 'g3-reopened'); expect(retry.id).toBe(job);
  await chat.startChat(cfg, db, retry);
  expect(peer.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session')).toHaveLength(1);
  expect(db.prepare('SELECT state,session_id FROM turn').all()).toEqual([{ state: 'admitted', session_id: 'ses_1' }]);
  expect(count(db, "SELECT COUNT(*) AS n FROM job WHERE kind='collect' AND state='queued'")).toBe(1);
  expect(prompts(peer)).toHaveLength(1);
  invariants(db, peer);
});

test('G3 create accepted while the old owner is held: the new lease reuses the tagged session and the stale response writes nothing', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const ticket = proposed(db); addBatch(db, ticket); chat.approve(cfg, db, ticket, '');
  let accepted!: () => void, release!: () => void;
  const created = new Promise<void>((resolve) => { accepted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  peer.state.hook = async (call, response) => {
    if (call.method !== 'POST' || call.url.pathname !== '/api/session') return false;
    const session = remoteSession('ses_held', String((call.body.location as { directory: string }).directory), call.body.metadata as never);
    session.title = String(call.body.title);
    peer.sessions.set(session.id, session);
    accepted();
    await gate;
    peer.json(response, { data: session }); return true;
  };
  const stale = claimed(db, cfg, 'g3-old-owner');
  const old = chat.startChat(cfg, db, stale);
  await created;
  vi.setSystemTime(new Date(Date.parse(stale.lease_until!) + 1));
  let after: ReturnType<typeof snapshot>, calls: number;
  {
    using other = openDb(path);
    const fresh = claimed(other, cfg, 'g3-new-owner');
    expect(fresh.id).toBe(stale.id);
    await chat.startChat(cfg, other, fresh, { peer: connect(cfg) });
    after = snapshot(other, ['ticket', 'turn', 'job', 'batch', 'timeline']);
    calls = peer.calls.length;
  }
  release(); await old;
  expect(snapshot(db, ['ticket', 'turn', 'job', 'batch', 'timeline'])).toEqual(after);
  expect(peer.calls).toHaveLength(calls);
  expect(peer.sessions.size).toBe(1);
  expect(row(db, 'ticket', ticket).session_id).toBe('ses_held');
  expect(db.prepare('SELECT state FROM turn').all()).toEqual([{ state: 'admitted' }]);
  expect(prompts(peer)).toHaveLength(1);
  invariants(db, peer);
});

test.each(['lost-ack', 'completion-fault'] as const)('G4 forward %s keeps the same head across reopen, collects it and sends the tail once', async (fault) => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let head: Record<string, unknown>, ticket: number, job: number;
  {
    using db = openDb(path);
    ticket = approvedSession(db, peer, cfg);
    addBatch(db, ticket, { own: true, text: 'Own answered context before forward' });
    const batch = addBatch(db, ticket, { text: 'Forward head input' });
    job = jobs.enqueue(db, 'forward', 'g4-head', { batch_ids: [batch] }, ticket);
    if (fault === 'lost-ack') peer.state.losePrompt = true;
    else db.exec("CREATE TRIGGER g4_fault BEFORE UPDATE OF state ON job WHEN NEW.kind='forward' AND NEW.state='done' BEGIN SELECT RAISE(ABORT,'g4 injected admission fault'); END");
    await chat.forward(cfg, db, claimed(db, cfg));
    head = { ...db.prepare('SELECT * FROM turn').get()! };
    expect(head).toMatchObject({ kind: 'forward', state: 'prepared' });
    expect(JSON.parse(String(head.context_ids))).toHaveLength(1);
    expect(String(head.text)).toContain('Forward head input');
    expect(peer.admissions.has(String(head.prompt_id))).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS n FROM job WHERE kind='collect'")).toBe(0);
    expect(row(db, 'job', job)).toMatchObject({ state: 'queued', turn_id: head.id });
    retryAt(db, job);
  }
  using db = openDb(path);
  if (fault === 'completion-fault') db.exec('DROP TRIGGER g4_fault');
  await chat.forward(cfg, db, claimed(db, cfg, 'g4-reopened'));
  expect(row(db, 'turn', Number(head.id))).toEqual({ ...head, state: 'admitted', admitted_at: expect.any(String), error_class: null, last_error: null });
  expect(prompts(peer)).toHaveLength(1);
  const tail = addBatch(db, ticket, { text: 'Tail after head admission' });
  const tailJob = jobs.enqueue(db, 'forward', 'g4-tail', { batch_ids: [tail] }, ticket);
  const collector = claimed(db, cfg); expect(collector.kind).toBe('collect');
  expect(jobs.claim(db, cfg, 'g4-tail-must-wait')).toBeNull();
  peer.finish('ses_1', String(head.prompt_id), 'STATUS: waiting_them | Head collected', 'succeeded', undefined, PEER_AT + 1000);
  await chat.collect(cfg, db, collector);
  const next = claimed(db, cfg); expect(next.id).toBe(tailJob);
  await chat.forward(cfg, db, next);
  const posts = prompts(peer);
  expect(posts).toHaveLength(2);
  expect(posts[0]!.body.id).toBe(head.prompt_id);
  expect(posts[1]!.body.id).not.toBe(head.prompt_id);
  expect(String(posts[0]!.body.text)).not.toContain('Tail after head admission');
  expect(String(posts[1]!.body.text)).toContain('Tail after head admission');
  expect(row(db, 'batch', JSON.parse(String(head.batch_ids))[0])).toMatchObject({ state: 'done', outcome: 'forwarded' });
  invariants(db, peer);
});

async function failedStart(peer: Peer, cfg: ReturnType<typeof chatFixture>['cfg'], db: DatabaseSync) {
  const ticket = proposed(db); const batch = addBatch(db, ticket); chat.approve(cfg, db, ticket, '');
  await chat.startChat(cfg, db, claimed(db, cfg));
  return { ticket, batch, first: { ...db.prepare('SELECT * FROM turn').get()! } };
}

test('G5 recovery input with a lost acknowledgement reconciles after reopen and the failed original is never replayed', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let recovery: Record<string, unknown>, batch: number, first: Record<string, unknown>, ticket: number;
  {
    using db = openDb(path);
    ({ ticket, batch, first } = await failedStart(peer, cfg, db));
    addBatch(db, ticket, { own: true, text: 'Own context after failed input' });
    peer.finish(String(first.session_id), String(first.prompt_id), '', 'interrupted', undefined, PEER_AT + 1000);
    await chat.collect(cfg, db, claimed(db, cfg));
    recovery = { ...db.prepare("SELECT * FROM turn WHERE kind='recovery'").get()! };
    const input = Number(db.prepare('SELECT id FROM job WHERE turn_id=?').get(Number(recovery.id))!.id);
    retryAt(db, input);
    peer.state.losePrompt = true;
    await chat.forward(cfg, db, claimed(db, cfg));
    expect(row(db, 'turn', Number(recovery.id)).state).toBe('prepared');
    expect(peer.admissions.has(String(recovery.prompt_id))).toBe(true);
    retryAt(db, input);
  }
  using db = openDb(path);
  await chat.forward(cfg, db, claimed(db, cfg, 'g5-reopened'));
  expect(row(db, 'turn', Number(recovery.id))).toMatchObject({ state: 'admitted', prompt_id: recovery.prompt_id, text: recovery.text });
  expect(prompts(peer).map((call) => call.body.id)).toEqual([first.prompt_id, recovery.prompt_id]);
  expect(count(db, "SELECT COUNT(*) AS n FROM turn WHERE kind='recovery'")).toBe(1);
  expect(count(db, "SELECT COUNT(*) AS n FROM job WHERE kind='collect' AND state='queued'")).toBe(1);
  peer.finish(String(first.session_id), String(recovery.prompt_id), 'STATUS: waiting_them | Recovered once', 'succeeded', undefined, PEER_AT + 5000);
  await chat.collect(cfg, db, claimed(db, cfg));
  expect(row(db, 'batch', batch)).toMatchObject({ state: 'done', outcome: 'forwarded' });
  expect(row(db, 'ticket', ticket)).toMatchObject({ report: 'waiting_them', report_line: 'Recovered once' });
  expect(row(db, 'turn', Number(first.id))).toMatchObject({ state: 'done', outcome: 'interrupted' });
  invariants(db, peer);
});

test('G5 collector completion fault while creating recovery leaves no half recovery; reopen creates exactly one', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let first: Record<string, unknown>, collector: jobs.Job;
  {
    using db = openDb(path);
    ({ first } = await failedStart(peer, cfg, db));
    peer.finish(String(first.session_id), String(first.prompt_id), '', 'failed', { type: 'provider.request', message: 'synthetic job failure', status: 400 }, PEER_AT + 1000);
    db.exec("CREATE TRIGGER g5_fault BEFORE UPDATE OF state ON job WHEN NEW.kind='collect' AND NEW.state='done' BEGIN SELECT RAISE(ABORT,'g5 injected recovery commit fault'); END");
    collector = claimed(db, cfg);
    await chat.collect(cfg, db, collector);
    expect(count(db, "SELECT COUNT(*) AS n FROM turn WHERE kind='recovery'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM job WHERE key=?", `recovery:turn:${first.id}`)).toBe(0);
    expect(row(db, 'turn', Number(first.id)).state).toBe('admitted');
    expect(row(db, 'job', collector.id)).toMatchObject({ state: 'queued' });
    retryAt(db, collector.id);
  }
  using db = openDb(path);
  db.exec('DROP TRIGGER g5_fault');
  await chat.collect(cfg, db, claimed(db, cfg, 'g5-reopened'));
  await chat.collect(cfg, db, collector);
  expect(count(db, "SELECT COUNT(*) AS n FROM turn WHERE kind='recovery'")).toBe(1);
  expect(count(db, "SELECT COUNT(*) AS n FROM job WHERE key=?", `recovery:turn:${first.id}`)).toBe(1);
  expect(row(db, 'turn', Number(first.id))).toMatchObject({ state: 'done', outcome: 'failed' });
  expect(row(db, 'job', collector.id).state).toBe('done');
  expect(prompts(peer)).toHaveLength(1);
  invariants(db, peer);
});

test('G5 admitted input proven absent from complete history and inbox becomes lost and gets one new recovery prompt', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const { first, batch } = await failedStart(peer, cfg, db);
  peer.admissions.delete(String(first.prompt_id));
  await chat.collect(cfg, db, claimed(db, cfg));
  expect(row(db, 'turn', Number(first.id))).toMatchObject({ state: 'done', outcome: 'lost' });
  const recovery = db.prepare("SELECT * FROM turn WHERE kind='recovery'").get()!;
  expect(recovery).toMatchObject({ recovery_of: first.id, input_turn: first.id, batch_ids: JSON.stringify([batch]) });
  retryAt(db, Number(db.prepare('SELECT id FROM job WHERE turn_id=?').get(Number(recovery.id))!.id));
  await chat.forward(cfg, db, claimed(db, cfg));
  expect(prompts(peer).map((call) => call.body.id)).toEqual([first.prompt_id, recovery.prompt_id]);
  invariants(db, peer);
});

test('G6 rename rejected before acceptance keeps the cached result; reopen with history down renames once and imports once', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let first: Record<string, unknown>, collector: jobs.Job, ticket: number, batch: number, title: string;
  {
    using db = openDb(path);
    ({ first, ticket, batch } = await failedStart(peer, cfg, db));
    title = String(peer.sessions.get(String(first.session_id))!.title);
    peer.finish(String(first.session_id), String(first.prompt_id), 'RCA-55\nSTATUS: waiting_them | Rename rejected first', 'succeeded', undefined, PEER_AT + 1000);
    let rejected = false;
    peer.state.hook = (call, response) => {
      if (rejected || call.method !== 'PATCH' || call.body.title === undefined) return false;
      rejected = true; peer.json(response, {}, 503); return true;
    };
    collector = claimed(db, cfg);
    await chat.collect(cfg, db, collector);
    expect(peer.sessions.get(String(first.session_id))!.title).toBe(title);
    expect(JSON.parse(String(row(db, 'job', collector.id).payload))).toHaveProperty('pending_report');
    expect(row(db, 'ticket', ticket).report).toBeNull();
    expect(row(db, 'turn', Number(first.id)).state).toBe('admitted');
    retryAt(db, collector.id);
  }
  peer.state.historyStatus = 503;
  using db = openDb(path);
  await chat.collect(cfg, db, claimed(db, cfg, 'g6-reopened'));
  await chat.collect(cfg, db, collector);
  expect(row(db, 'ticket', ticket)).toMatchObject({ report: 'waiting_them', report_line: 'Rename rejected first', report_at: '2026-11-06T00:00:01.000000Z' });
  expect(peer.sessions.get(String(first.session_id))!.title).not.toBe(title);
  expect(peer.calls.filter((call) => call.method === 'PATCH' && call.body.title !== undefined)).toHaveLength(2);
  expect(count(db, "SELECT COUNT(*) AS n FROM ticket_ref WHERE key='RCA-55'")).toBe(1);
  expect(count(db, "SELECT COUNT(*) AS n FROM timeline WHERE kind='status'")).toBe(1);
  expect(row(db, 'turn', Number(first.id))).toMatchObject({ state: 'done', outcome: 'succeeded', completed_at: '2026-11-06T00:00:01.000000Z' });
  expect(row(db, 'batch', batch)).toMatchObject({ state: 'done', outcome: 'forwarded' });
  expect(prompts(peer)).toHaveLength(1);
  invariants(db, peer);
});

test('G6 collector job-completion fault after every terminal write rolls all back; reopen imports exactly once without another PATCH', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let first: Record<string, unknown>, collector: jobs.Job, ticket: number, batch: number;
  {
    using db = openDb(path);
    ({ first, ticket, batch } = await failedStart(peer, cfg, db));
    peer.finish(String(first.session_id), String(first.prompt_id), 'RCA-56\nSTATUS: needs_you | Late completion fault', 'succeeded', undefined, PEER_AT + 1000);
    db.exec("CREATE TRIGGER g6_fault BEFORE UPDATE OF state ON job WHEN NEW.kind='collect' AND NEW.state='done' BEGIN SELECT RAISE(ABORT,'g6 injected completion fault'); END");
    collector = claimed(db, cfg);
    await chat.collect(cfg, db, collector);
    expect(row(db, 'ticket', ticket)).toMatchObject({ report: null, session_title: null });
    expect(count(db, "SELECT COUNT(*) AS n FROM ticket_ref WHERE key='RCA-56'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM timeline WHERE kind='status'")).toBe(0);
    expect(row(db, 'turn', Number(first.id)).state).toBe('admitted');
    expect(row(db, 'batch', batch).state).toBe('delivered');
    expect(row(db, 'job', collector.id).state).toBe('queued');
    retryAt(db, collector.id);
  }
  peer.state.historyStatus = 503;
  using db = openDb(path);
  db.exec('DROP TRIGGER g6_fault');
  await chat.collect(cfg, db, claimed(db, cfg, 'g6-reopened'));
  expect(row(db, 'ticket', ticket)).toMatchObject({ report: 'needs_you', report_line: 'Late completion fault' });
  expect(count(db, "SELECT COUNT(*) AS n FROM ticket_ref WHERE key='RCA-56'")).toBe(1);
  expect(count(db, "SELECT COUNT(*) AS n FROM timeline WHERE kind='status'")).toBe(1);
  expect(row(db, 'turn', Number(first.id))).toMatchObject({ state: 'done', outcome: 'succeeded' });
  expect(row(db, 'batch', batch)).toMatchObject({ state: 'done', outcome: 'forwarded' });
  expect(peer.calls.filter((call) => call.method === 'PATCH' && call.body.title !== undefined)).toHaveLength(1);
  expect(prompts(peer)).toHaveLength(1);
  invariants(db, peer);
});

test('G6 manual close during an accepted rename defers the stale projection and the retry keeps the close marker', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const { first, ticket, batch } = await failedStart(peer, cfg, db);
  peer.finish(String(first.session_id), String(first.prompt_id), 'STATUS: waiting_them | Older output', 'succeeded', undefined, PEER_AT + 1000);
  let closed = false;
  peer.state.hook = (call) => {
    if (!closed && call.method === 'PATCH' && call.body.title !== undefined) {
      closed = true;
      vi.setSystemTime(new Date('2026-11-06T00:00:30Z'));
      using observer = openDb(path);
      close(observer, ticket, 'Manual close during rename');
    }
    return false;
  };
  const collector = claimed(db, cfg);
  await chat.collect(cfg, db, collector);
  expect(row(db, 'job', collector.id).state).toBe('queued');
  expect(row(db, 'ticket', ticket)).toMatchObject({ lifecycle: 'done', report_line: 'Manual close during rename' });
  await chat.collect(cfg, db, claimed(db, cfg, 'g6-race-retry'));
  expect(row(db, 'job', collector.id).state).toBe('done');
  expect(row(db, 'ticket', ticket)).toMatchObject({ lifecycle: 'done', report_line: 'Manual close during rename', report_at: '2026-11-06T00:00:30.000000Z' });
  expect(row(db, 'turn', Number(first.id))).toMatchObject({ state: 'done', outcome: 'succeeded' });
  expect(row(db, 'batch', batch)).toMatchObject({ state: 'done', outcome: 'forwarded' });
  expect(peer.sessions.get(String(first.session_id))!.title).toContain('[Done]');
  expect(prompts(peer)).toHaveLength(1);
  invariants(db, peer);
});

test('G7 per-ticket sync report commit survives a schedule-commit fault and is imported exactly once after reopen', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let ticket: number, job: number, imported: Record<string, unknown>;
  {
    using db = openDb(path);
    ticket = approvedSession(db, peer, cfg);
    await connect(cfg).prompt('ses_1', 'msg_direct', 'Direct input in the approved chat');
    peer.finish('ses_1', 'msg_direct', 'RCA-77\nSTATUS: needs_you | Direct sync report', 'succeeded', undefined, PEER_AT + 1000);
    job = jobs.enqueue(db, 'sync', `sync:ticket:${ticket}:2026-11-06`, {}, ticket);
    db.exec("CREATE TRIGGER g7_fault BEFORE UPDATE OF state ON job WHEN NEW.kind='sync' AND NEW.state='done' BEGIN SELECT RAISE(ABORT,'g7 injected schedule fault'); END");
    await chat.sync(cfg, db, claimed(db, cfg));
    imported = { ...row(db, 'ticket', ticket) };
    expect(imported).toMatchObject({ report: 'needs_you', report_line: 'Direct sync report', report_message_id: 'asst_msg_direct' });
    expect(row(db, 'job', job)).toMatchObject({ state: 'queued', attempts: 1 });
    expect(String(row(db, 'job', job).last_error)).toContain('g7 injected schedule fault');
    retryAt(db, job);
  }
  using db = openDb(path);
  db.exec('DROP TRIGGER g7_fault');
  await chat.sync(cfg, db, claimed(db, cfg, 'g7-reopened'));
  expect(row(db, 'ticket', ticket)).toEqual(imported);
  expect(count(db, "SELECT COUNT(*) AS n FROM ticket_ref WHERE key='RCA-77'")).toBe(1);
  expect(count(db, "SELECT COUNT(*) AS n FROM timeline WHERE kind='status'")).toBe(1);
  const done = row(db, 'job', job);
  expect(done.state).toBe('done');
  expect(Date.parse(String(done.next_at)) - Date.now()).toBe(cfg.jobs.sync_seconds * 1000);
  expect(peer.calls.filter((call) => call.method === 'PATCH' && call.body.title !== undefined)).toHaveLength(1);
  expect(prompts(peer)).toHaveLength(1);
  invariants(db, peer);
});

function idleTicket(db: DatabaseSync, peer: Peer, cfg: ReturnType<typeof chatFixture>['cfg']) {
  const old = '2026-11-03T00:00:00.000000Z';
  const ticket = approvedSession(db, peer, cfg, { approved_at: old, last_activity_at: old, report: 'waiting_them', report_line: 'Original report', report_at: old });
  peer.sessions.get('ses_1')!.time.created = Date.parse(old);
  return { ticket, job: jobs.enqueue(db, 'archive', `archive:ticket:${ticket}:2026-11-06`, {}, ticket) };
}

test('G8 archive intent committed but PATCH never accepted reconciles after reopen with exactly one accepted archive', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let ticket: number, job: number;
  {
    using db = openDb(path);
    ({ ticket, job } = idleTicket(db, peer, cfg));
    let dropped = false;
    peer.state.hook = (call, _response, request) => {
      if (dropped || call.method !== 'PATCH' || call.body.archived !== true) return false;
      dropped = true; request.socket.destroy(); return true;
    };
    await chat.archive(cfg, db, claimed(db, cfg));
    expect(peer.sessions.get('ses_1')!.time.archived).toBeUndefined();
    expect(JSON.parse(String(row(db, 'job', job).payload)).pending_archive).toMatchObject({ ticket, session_id: 'ses_1', archived: true });
    expect(row(db, 'ticket', ticket).archived_at).toBeNull();
    retryAt(db, job);
  }
  using db = openDb(path);
  const before = { ...row(db, 'ticket', ticket) };
  await chat.archive(cfg, db, claimed(db, cfg, 'g8-reopened'));
  expect(peer.sessions.get('ses_1')!.time.archived).toBeDefined();
  expect(row(db, 'ticket', ticket)).toEqual({ ...before, archived_at: expect.any(String) });
  expect(JSON.parse(String(row(db, 'job', job).payload))).not.toHaveProperty('pending_archive');
  expect(row(db, 'job', job).state).toBe('done');
  expect(peer.calls.filter((call) => call.method === 'PATCH').map((call) => call.body.archived)).toEqual([true, true]);
  expect(prompts(peer)).toHaveLength(0);
  invariants(db, peer);
});

test('G8 fault after marker and intent commit keeps the marker; reopen completes without another archive PATCH', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let ticket: number, job: number, marker: unknown;
  {
    using db = openDb(path);
    ({ ticket, job } = idleTicket(db, peer, cfg));
    db.exec("CREATE TRIGGER g8_fault BEFORE UPDATE OF state ON job WHEN NEW.kind='archive' AND NEW.state='done' BEGIN SELECT RAISE(ABORT,'g8 injected completion fault'); END");
    await chat.archive(cfg, db, claimed(db, cfg));
    marker = row(db, 'ticket', ticket).archived_at;
    expect(marker).toEqual(expect.any(String));
    expect(JSON.parse(String(row(db, 'job', job).payload))).not.toHaveProperty('pending_archive');
    expect(row(db, 'job', job).state).toBe('queued');
    retryAt(db, job);
  }
  using db = openDb(path);
  db.exec('DROP TRIGGER g8_fault');
  await chat.archive(cfg, db, claimed(db, cfg, 'g8-reopened'));
  expect(row(db, 'ticket', ticket)).toMatchObject({ archived_at: marker, report_line: 'Original report' });
  expect(row(db, 'job', job).state).toBe('done');
  expect(peer.calls.filter((call) => call.method === 'PATCH' && call.body.archived !== undefined).map((call) => call.body.archived)).toEqual([true]);
  invariants(db, peer);
});

function triageSource() {
  return { source: 'outlook', account: 'me@acme.invalid', conversation_id: 'conversation', conversation_title: 'Original title',
    message_id: 'native-1', sender: 'bob@acme.invalid', sender_name: 'Bob', sender_is_me: false, sent_at: '2026-11-05T23:50:00Z', text: 'Check RCA-12' };
}

function triageOutcome(db: DatabaseSync) {
  expect(db.prepare('SELECT lifecycle,session_id,approved_at FROM ticket').all()).toEqual([{ lifecycle: 'proposed', session_id: null, approved_at: null }]);
  expect(count(db, 'SELECT COUNT(*) AS n FROM triage_log')).toBe(1);
  expect(db.prepare('SELECT key FROM ticket_ref').all()).toEqual([{ key: 'RCA-12' }]);
  expect(db.prepare('SELECT state,outcome FROM batch').all()).toEqual([{ state: 'done', outcome: 'proposed' }]);
  expect(db.prepare('SELECT state FROM job').all()).toEqual([{ state: 'done' }]);
  expect(count(db, 'SELECT COUNT(*) AS n FROM turn')).toBe(0);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

test('G1 triage worker abandoned while its provider response is held cannot write; the new owner finishes once after reopen', async () => {
  const { cfg } = kbFixture();
  let held!: () => void, release!: () => void;
  const requested = new Promise<void>((resolve) => { held = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await using peer = await kbPeer(async (_body, index) => { if (index === 0) { held(); await gate; } return { body: text() }; });
  const providers = { providers: { first: provider(peer.baseURL) } };
  let baseline: ReturnType<typeof snapshot>, stale: jobs.Job;
  {
    using db = openDb(cfg.db.path);
    ingest(db, triageSource());
    schedule(db, cfg, AT);
    baseline = snapshot(db, source);
    stale = jobs.claim(db, cfg, 'g1-abandoned', AT)!;
  }
  using abandoned = openDb(cfg.db.path);
  const old = handleTriage(cfg, abandoned, stale, providers);
  await requested;
  vi.setSystemTime(new Date(Date.parse(stale.lease_until!) + 1));
  let finished: ReturnType<typeof snapshot>;
  {
    using db = openDb(cfg.db.path);
    const fresh = jobs.claim(db, cfg, 'g1-new-owner')!;
    expect(fresh.id).toBe(stale.id);
    await handleTriage(cfg, db, fresh, providers);
    finished = snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'batch', 'triage_log', 'job', 'health', ...source]);
  }
  release(); await old;
  using db = openDb(cfg.db.path);
  expect(snapshot(db, ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'batch', 'triage_log', 'job', 'health', ...source])).toEqual(finished);
  expect(snapshot(db, source)).toEqual(baseline);
  expect(peer.requests).toHaveLength(2);
  triageOutcome(db);
});

test.each(['ticket', 'ticket_ref', 'timeline', 'triage_log', 'job'])('G2 %s write fault rolls back, the reopened job completes exactly once and is never reassessed', async (table) => {
  const { cfg } = kbFixture();
  await using peer = await kbPeer(() => ({ body: text() }));
  const providers = { providers: { first: provider(peer.baseURL) } };
  let baseline: ReturnType<typeof snapshot>, id: number;
  {
    using db = openDb(cfg.db.path);
    ingest(db, triageSource());
    schedule(db, cfg, AT);
    baseline = snapshot(db, source);
    const before = snapshot(db, ['ticket', 'ticket_ref', 'timeline', 'triage_log', 'batch']);
    const condition = table === 'job' ? "UPDATE ON job WHEN NEW.state='done'" : `INSERT ON "${table}"`;
    db.exec(`CREATE TRIGGER g2_fault BEFORE ${condition} BEGIN SELECT RAISE(ABORT, 'g2 injected ${table} fault'); END`);
    const job = jobs.claim(db, cfg, 'g2-first', AT)!; id = job.id;
    await handleTriage(cfg, db, job, providers);
    expect(snapshot(db, ['ticket', 'ticket_ref', 'timeline', 'triage_log', 'batch'])).toEqual(before);
    expect(row(db, 'job', id).state).toBe('queued');
    retryAt(db, id);
  }
  using db = openDb(cfg.db.path);
  db.exec('DROP TRIGGER g2_fault');
  const retry = jobs.claim(db, cfg, 'g2-reopened')!;
  expect(retry.id).toBe(id);
  await handleTriage(cfg, db, retry, providers);
  triageOutcome(db);
  expect(snapshot(db, source)).toEqual(baseline);
  await handleTriage(cfg, db, retry, providers);
  expect(jobs.claim(db, cfg, 'g2-after-commit')).toBeNull();
  triageOutcome(db);
});

test('G2 update-mode proposal fault rolls back the UPDATE branch and completes once after reopen', async () => {
  const { cfg } = kbFixture();
  let owner: number, id: number;
  await using peer = await kbPeer(() => ({ body: text(JSON.stringify(decision({ action: 'update', ticket: owner }))) }));
  const providers = { providers: { first: provider(peer.baseURL) } };
  {
    using db = openDb(cfg.db.path);
    owner = Number(db.prepare("INSERT INTO ticket(title,client,proposal,created_at) VALUES ('Synthetic ticket','acme','Old proposal',?)").run(AT).lastInsertRowid);
    ingest(db, triageSource());
    db.prepare(`INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,1,'primary','rule',?)`).run(owner, AT);
    schedule(db, cfg, AT);
    db.exec("CREATE TRIGGER g2_update BEFORE UPDATE OF proposal ON ticket BEGIN SELECT RAISE(ABORT,'g2 injected proposal update fault'); END");
    const job = jobs.claim(db, cfg, 'g2-update', AT)!; id = job.id;
    await handleTriage(cfg, db, job, providers);
    expect(db.prepare('SELECT proposal FROM ticket').all()).toEqual([{ proposal: 'Old proposal' }]);
    expect(count(db, 'SELECT COUNT(*) AS n FROM triage_log')).toBe(0);
    retryAt(db, id);
  }
  using db = openDb(cfg.db.path);
  db.exec('DROP TRIGGER g2_update');
  await handleTriage(cfg, db, jobs.claim(db, cfg, 'g2-update-reopened')!, providers);
  expect(db.prepare('SELECT id,proposal,lifecycle,approved_at FROM ticket').all()).toEqual([{ id: owner!, proposal: 'Inspect logs', lifecycle: 'proposed', approved_at: null }]);
  expect(count(db, 'SELECT COUNT(*) AS n FROM triage_log')).toBe(1);
  expect(row(db, 'job', id).state).toBe('done');
  expect(db.prepare('SELECT state,outcome,ticket FROM batch').all()).toEqual([{ state: 'done', outcome: 'proposed', ticket: owner! }]);
});
