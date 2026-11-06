import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openDb } from '../src/dispatcher/db.ts';
import * as jobs from '../src/dispatcher/jobs.ts';
import * as chat from '../src/dispatcher/chat.ts';
import { close, merge, route } from '../src/dispatcher/tickets.ts';
import { connect } from '../src/dispatcher/opencode.ts';
import { AT, addBatch, chatFixture, claimed, proposed, row } from './chat-support.ts';
import { remoteSession, scriptedPeer, PEER_AT } from './opencode-support.ts';

beforeEach(() => { vi.stubEnv('INBOX_OPENCODE_PASSWORD', ''); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT)); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

test('lost create response reconciles durable tag across DB/client restart without another create', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let ticket: number;
  let id: number;
  {
    using db = openDb(path);
    ticket = proposed(db);
    addBatch(db, ticket);
    chat.approve(cfg, db, ticket, 'Exact instruction');
    const job = claimed(db, cfg);
    id = job.id;
    peer.state.loseCreate = true;
    await chat.startChat(cfg, db, job);
    expect(row(db, 'ticket', ticket).session_id).toBeNull();
    expect(row(db, 'job', id)).toMatchObject({ state: 'queued', error_class: 'dependency', attempts: 0 });
    expect(peer.sessions.size).toBe(1);
  }
  vi.setSystemTime(new Date('2026-11-06T00:00:10Z'));
  using restarted = openDb(path);
  const retry = claimed(restarted, cfg, 'after-restart');
  expect(retry.id).toBe(id);
  await chat.startChat(cfg, restarted, retry, { peer: connect(cfg) });
  expect(peer.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session')).toHaveLength(1);
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
  expect(row(restarted, 'ticket', ticket).session_id).toBe([...peer.sessions.keys()][0]);
});

test('lost admission response retains reservation and immutable input across local restart, then collects inbox instead of resending', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  cfg.jobs.turn_concurrency = 1;
  let id: number;
  let saved: Record<string, unknown>;
  {
    using db = openDb(path);
    const ticket = proposed(db);
    addBatch(db, ticket);
    chat.approve(cfg, db, ticket, 'Exact original');
    const job = claimed(db, cfg); id = job.id;
    peer.state.losePrompt = true;
    await chat.startChat(cfg, db, job);
    saved = { ...db.prepare('SELECT * FROM turn').get()! };
    expect(saved).toMatchObject({ state: 'prepared', reserved_at: AT });
    expect(peer.admissions.has(String(saved.prompt_id))).toBe(true);
    const other = proposed(db);
    chat.approve(cfg, db, other, 'Other ticket');
    expect(jobs.claim(db, cfg, 'blocked-by-reservation')).toBeNull();
  }
  vi.setSystemTime(new Date('2026-11-06T00:00:10Z'));
  using restarted = openDb(path);
  const retry = claimed(restarted, cfg, 'after-restart'); expect(retry.id).toBe(id);
  await chat.startChat(cfg, restarted, retry, { peer: connect(cfg) });
  expect(row(restarted, 'turn', Number(saved!.id))).toMatchObject({ state: 'admitted', prompt_id: saved!.prompt_id, text: saved!.text });
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
  expect(claimed(restarted, cfg, 'collector').kind).toBe('collect');
});

test('proven absent prepared input retries exact id/text; unreachable history never resubmits or releases its slot', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const ticket = proposed(db, { lifecycle: 'active', approved_at: AT, approval_note: '', session_id: 'ses_1' });
  peer.sessions.set('ses_1', remoteSession('ses_1', cfg.opencode.directory));
  const batch = addBatch(db, ticket);
  jobs.enqueue(db, 'forward', 'prepared-before-crash', { batch_ids: [batch] }, ticket);
  const job = claimed(db, cfg);
  const prepared = chat.prepareTurn(cfg, db, job, 'forward')!;
  peer.state.historyStatus = 503;
  await chat.forward(cfg, db, job);
  expect(row(db, 'job', job.id)).toMatchObject({ state: 'queued', error_class: 'dependency', attempts: 0, turn_id: prepared.id });
  expect(row(db, 'turn', prepared.id)).toMatchObject({ state: 'prepared', reserved_at: AT });
  expect(peer.calls.some((call) => call.url.pathname.endsWith('/prompt'))).toBe(false);
  vi.setSystemTime(new Date('2026-11-06T00:00:10Z'));
  peer.state.historyStatus = 200;
  await chat.forward(cfg, db, claimed(db, cfg));
  const posted = peer.calls.find((call) => call.url.pathname.endsWith('/prompt'))!;
  expect(posted.body).toMatchObject({ id: prepared.prompt_id, text: prepared.text });
});

test('still-running admitted input after restart is collected without recovery or new prompt', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let turn: Record<string, unknown>;
  {
    using db = openDb(path);
    const ticket = proposed(db);
    chat.approve(cfg, db, ticket, '');
    await chat.startChat(cfg, db, claimed(db, cfg));
    turn = { ...db.prepare('SELECT * FROM turn').get()! };
    peer.deliver(String(turn.session_id), String(turn.prompt_id));
    claimed(db, cfg, 'before-crash');
  }
  vi.setSystemTime(new Date('2026-11-06T00:02:01Z'));
  using restarted = openDb(path);
  await chat.collect(cfg, restarted, claimed(restarted, cfg, 'after-restart'), { restartAt: '2026-11-06T00:01:30Z' });
  expect(restarted.prepare('SELECT COUNT(*) AS n FROM turn').get()!.n).toBe(1);
  expect(restarted.prepare("SELECT COUNT(*) AS n FROM turn WHERE kind='recovery'").get()!.n).toBe(0);
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
  expect(row(restarted, 'turn', Number(turn!.id)).state).toBe('admitted');
});

test('returned prompt mismatch parks visibly, retains uncertainty, retry reconciles rather than repeats', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const ticket = proposed(db);
  chat.approve(cfg, db, ticket, '');
  peer.state.wrongPromptID = true;
  const job = claimed(db, cfg);
  await chat.startChat(cfg, db, job);
  expect(row(db, 'job', job.id)).toMatchObject({ state: 'parked', error_class: 'job' });
  expect(db.prepare('SELECT state,reserved_at FROM turn').get()).toMatchObject({ state: 'prepared', reserved_at: AT });
  jobs.retry(db, job.id);
  peer.state.wrongPromptID = false;
  await chat.startChat(cfg, db, claimed(db, cfg));
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
});

test('required collector outranks an already queued later forward through the entire ticket chain', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const ticket = proposed(db);
  chat.approve(cfg, db, ticket, '');
  const start = claimed(db, cfg);
  const batch = addBatch(db, ticket, { text: 'Later FIFO input' });
  const later = jobs.enqueue(db, 'forward', 'later', { batch_ids: [batch] }, ticket);
  await chat.startChat(cfg, db, start);
  const collector = claimed(db, cfg);
  expect(collector.kind).toBe('collect');
  expect(collector.id).toBeGreaterThan(later);
  await chat.collect(cfg, db, collector);
  expect(jobs.claim(db, cfg, 'must-wait')).toBeNull();
  const turn = db.prepare('SELECT * FROM turn').get()!;
  peer.finish(String(turn.session_id), String(turn.prompt_id), 'STATUS: waiting_them | First finished', 'succeeded', undefined, PEER_AT + 1000);
  vi.setSystemTime(new Date('2026-11-06T00:00:10Z'));
  await chat.collect(cfg, db, claimed(db, cfg));
  expect(claimed(db, cfg).id).toBe(later);
});

test('parked prepared forward absorbs tail without mutating input, reconciles and collects before separate tail submission', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const ticket = proposed(db, { lifecycle: 'active', approved_at: AT, approval_note: '', session_id: 'ses_1' });
  peer.sessions.set('ses_1', remoteSession('ses_1', cfg.opencode.directory));
  const first = addBatch(db, ticket, { text: 'First immutable input' });
  const id = jobs.enqueue(db, 'forward', 'head', { batch_ids: [first] }, ticket);
  const job = claimed(db, cfg);
  const original = chat.prepareTurn(cfg, db, job, 'forward')!;
  peer.state.wrongPromptID = true;
  await chat.forward(cfg, db, job);
  expect(row(db, 'job', id).state).toBe('parked');
  const tail = addBatch(db, ticket, { text: 'Separate later tail' });
  expect(jobs.enqueue(db, 'forward', 'tail', { batch_ids: [tail] }, ticket)).toBe(id);
  expect(row(db, 'turn', original.id).text).toBe(original.text);
  jobs.retry(db, id); peer.state.wrongPromptID = false;
  await chat.forward(cfg, db, claimed(db, cfg));
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
  const collector = claimed(db, cfg); expect(collector.kind).toBe('collect');
  peer.finish('ses_1', original.prompt_id, 'STATUS: waiting_them | First complete', 'succeeded', undefined, PEER_AT + 1000);
  await chat.collect(cfg, db, collector);
  const tailJob = claimed(db, cfg); expect(tailJob.kind).toBe('forward');
  await chat.forward(cfg, db, tailJob);
  const posts = peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'));
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body.id).not.toBe(original.prompt_id);
  expect(String(posts[1]!.body.text)).toContain('Separate later tail');
  expect(String(posts[0]!.body.text)).not.toContain('Separate later tail');
});

test('lost rename PATCH persists pending report, reconciles readback after restart and never repeats input', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let turn: Record<string, unknown>;
  let collector: number;
  {
    using db = openDb(path);
    const ticket = proposed(db);
    chat.approve(cfg, db, ticket, '');
    await chat.startChat(cfg, db, claimed(db, cfg));
    turn = { ...db.prepare('SELECT * FROM turn').get()! };
    peer.finish(String(turn.session_id), String(turn.prompt_id), 'STATUS: waiting_them | Rename durable', 'succeeded', undefined, PEER_AT + 1000);
    const job = claimed(db, cfg); collector = job.id;
    peer.state.loseRename = true;
    await chat.collect(cfg, db, job);
    expect(row(db, 'job', job.id)).toMatchObject({ state: 'queued', error_class: 'dependency', attempts: 0 });
    expect(JSON.parse(String(row(db, 'job', job.id).payload))).toHaveProperty('pending_report');
    expect(row(db, 'ticket', ticket).report).toBeNull();
    expect(peer.sessions.get(String(turn.session_id))!.title).toContain('Waiting on them');
  }
  vi.setSystemTime(new Date('2026-11-06T00:00:10Z'));
  peer.state.historyStatus = 503;
  using restarted = openDb(path);
  const job = claimed(restarted, cfg, 'restart'); expect(job.id).toBe(collector!);
  await chat.collect(cfg, restarted, job);
  expect(row(restarted, 'job', job.id).state).toBe('done');
  expect(row(restarted, 'ticket', Number(turn!.ticket))).toMatchObject({ report: 'waiting_them', report_at: '2026-11-06T00:00:01.000000Z' });
  expect(peer.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
});

test('older collector cannot overwrite a newer direct report, manual close or merge', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const ticket = proposed(db);
  chat.approve(cfg, db, ticket, '');
  await chat.startChat(cfg, db, claimed(db, cfg));
  const turn = db.prepare('SELECT * FROM turn').get()!;
  peer.finish(String(turn.session_id), String(turn.prompt_id), 'STATUS: working | Older collector', 'succeeded', undefined, PEER_AT + 1000);
  const api = connect(cfg);
  await api.prompt(String(turn.session_id), 'msg_direct', 'Direct input');
  peer.finish(String(turn.session_id), 'msg_direct', 'STATUS: needs_you | Newer direct report', 'succeeded', undefined, PEER_AT + 5000);
  jobs.enqueue(db, 'sync', 'direct-sync', {});
  const collecting = claimed(db, cfg); expect(collecting.kind).toBe('collect');
  const syncJob = claimed(db, cfg); expect(syncJob.kind).toBe('sync');
  await chat.sync(cfg, db, syncJob);
  await chat.collect(cfg, db, collecting);
  expect(row(db, 'ticket', ticket)).toMatchObject({ report: 'needs_you', report_line: 'Newer direct report', report_at: '2026-11-06T00:00:05.000000Z' });
  vi.setSystemTime(new Date('2026-11-06T00:01:00Z'));
  close(db, ticket, 'Manual terminal marker');
  const closed = { ...row(db, 'ticket', ticket) };
  vi.setSystemTime(new Date('2026-11-06T00:05:00Z'));
  await chat.sync(cfg, db, claimed(db, cfg));
  expect(row(db, 'ticket', ticket)).toEqual({ ...closed, session_title: expect.stringContaining('[Done]') });
  const other = proposed(db);
  merge(db, other, proposed(db));
  expect(row(db, 'ticket', other).lifecycle).toBe('done');
});

test('failed provider turn becomes a new reserved recovery after generic retry floor, never replaying failed input', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const ticket = proposed(db);
  chat.approve(cfg, db, ticket, '');
  await chat.startChat(cfg, db, claimed(db, cfg));
  const first = db.prepare('SELECT * FROM turn').get()!;
  const error = { type: 'provider.request', message: 'synthetic limit', status: 429, retryAfterMs: 3600000, response: { body: 'synthetic structured detail' } };
  peer.finish(String(first.session_id), String(first.prompt_id), '', 'failed', error);
  await chat.collect(cfg, db, claimed(db, cfg), { restartAt: '2026-11-06T00:17:00Z' });
  const recovery = db.prepare("SELECT * FROM turn WHERE kind='recovery'").get()!;
  expect(recovery).toMatchObject({ state: 'prepared', recovery_of: first.id, input_turn: first.id, recovery_count: 0, reserved_at: AT });
  expect(String(recovery.text)).toContain('host restarted at 00:17; check sent items, pull requests and files before repeating any outside action');
  expect(String(recovery.text)).toContain('synthetic structured detail');
  expect(recovery.prompt_id).not.toBe(first.prompt_id);
  const input = db.prepare("SELECT * FROM job WHERE state='queued' AND kind='forward'").get()!;
  expect(input).toMatchObject({ turn_id: recovery.id, next_at: '2026-11-06T01:00:00.000000Z' });
  expect(row(db, 'turn', Number(first.id))).toMatchObject({ state: 'done', outcome: 'failed' });
  expect(jobs.claim(db, cfg, 'before-backoff')).toBeNull();
  vi.setSystemTime(new Date('2026-11-06T01:00:00Z'));
  await chat.forward(cfg, db, claimed(db, cfg));
  const posts = peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'));
  expect(posts.map((call) => call.body.id)).toEqual([first.prompt_id, recovery.prompt_id]);
  expect(db.prepare("SELECT detail FROM health WHERE dependency='opencode:execution'").get()).toBeTruthy();
});

test('two nondependency recoveries maximum survives intervening dependency failure without budget reset', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  cfg.jobs.turn_concurrency = 1;
  using db = openDb(path);
  const ticket = proposed(db);
  chat.approve(cfg, db, ticket, '');
  await chat.startChat(cfg, db, claimed(db, cfg));
  const failures = [
    { outcome: 'interrupted' as const, error: undefined },
    { outcome: 'failed' as const, error: { type: 'provider.transport', message: 'synthetic unavailable', retryAfterMs: 1500 } },
    { outcome: 'interrupted' as const, error: undefined },
    { outcome: 'interrupted' as const, error: undefined },
  ];
  for (const [index, failure] of failures.entries()) {
    const turn = db.prepare('SELECT * FROM turn ORDER BY id DESC LIMIT 1').get()!;
    peer.finish(String(turn.session_id), String(turn.prompt_id), '', failure.outcome, failure.error, Date.now() + 1);
    const collector = claimed(db, cfg);
    await chat.collect(cfg, db, collector);
    if (index === failures.length - 1) {
      expect(row(db, 'job', collector.id)).toMatchObject({ state: 'parked', error_class: 'job' });
    } else {
      const next = db.prepare("SELECT * FROM job WHERE state='queued' AND kind='forward' ORDER BY id LIMIT 1").get()!;
      vi.setSystemTime(new Date(String(next.next_at)));
      await chat.forward(cfg, db, claimed(db, cfg));
    }
  }
  expect(db.prepare('SELECT recovery_count FROM turn ORDER BY id').all().map((turn) => turn.recovery_count)).toEqual([0, 1, 1, 2]);
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'))).toHaveLength(4);
  expect(db.prepare("SELECT COUNT(*) AS n FROM turn WHERE kind='recovery'").get()!.n).toBe(3);
});

test.each(['queued', 'prepared', 'uncertain', 'remote-running', 'inbox', 'recent'] as const)('archive refuses %s work despite old title-update timestamps', async (blocker) => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const old = '2026-11-04T00:00:00.000000Z';
  const ticket = proposed(db, { lifecycle: 'active', approved_at: old, session_id: 'ses_1', last_activity_at: old });
  const session = remoteSession('ses_1', cfg.opencode.directory);
  session.time.created = PEER_AT - 3 * 86400000;
  session.time.updated = Date.now() - 3 * 86400000;
  peer.sessions.set('ses_1', session);
  if (blocker === 'queued') jobs.enqueue(db, 'forward', 'pending', {}, ticket);
  if (blocker === 'prepared' || blocker === 'uncertain') {
    db.prepare("INSERT INTO turn(ticket,kind,prompt_id,text,session_id,state,reserved_at,last_error,created_at) VALUES (?,'forward','msg_held','Held','ses_1','prepared',?,?,?)")
      .run(ticket, blocker === 'uncertain' ? old : null, blocker === 'uncertain' ? 'Submission uncertain' : null, old);
  }
  if (blocker === 'remote-running') session.time.busy = Date.now();
  if (blocker === 'inbox') await connect(cfg).prompt('ses_1', 'msg_waiting', 'Direct queued input');
  if (blocker === 'recent') {
    await connect(cfg).prompt('ses_1', 'msg_recent', 'Recent direct input');
    peer.finish('ses_1', 'msg_recent', 'STATUS: waiting_them | Recent direct work', 'succeeded', undefined, PEER_AT - 1000);
  }
  jobs.enqueue(db, 'archive', 'archive', {});
  const job = blocker === 'queued' ? (claimed(db, cfg), claimed(db, cfg)) : claimed(db, cfg);
  expect(job.kind).toBe('archive');
  await chat.archive(cfg, db, job);
  expect(peer.calls.filter((call) => call.method === 'PATCH' && call.body.archived === true)).toHaveLength(0);
  expect(row(db, 'ticket', ticket).archived_at).toBeNull();
});

test('archive reconciles lost acceptance across restart and persists marker without duplicate PATCH', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let ticket: number;
  {
    using db = openDb(path);
    ticket = proposed(db, { lifecycle: 'done', approved_at: AT, session_id: 'ses_1', last_activity_at: '2026-11-04T00:00:00.000000Z' });
    peer.sessions.set('ses_1', remoteSession('ses_1', cfg.opencode.directory));
    peer.sessions.get('ses_1')!.time.created = PEER_AT - 3 * 86400000;
    jobs.enqueue(db, 'archive', 'archive', {});
    peer.state.loseArchive = true;
    await chat.archive(cfg, db, claimed(db, cfg));
    expect(peer.sessions.get('ses_1')!.time.archived).toBeTruthy();
    expect(row(db, 'ticket', ticket).archived_at).toBeNull();
  }
  vi.setSystemTime(new Date('2026-11-06T00:00:10Z'));
  using restarted = openDb(path);
  await chat.archive(cfg, restarted, claimed(restarted, cfg));
  expect(row(restarted, 'ticket', ticket!).archived_at).toBeTruthy();
  expect(peer.calls.filter((call) => call.method === 'PATCH' && call.body.archived === true)).toHaveLength(1);
});

test('recovery snapshots newly answered own context in the same immutable preparation transaction', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const ticket = proposed(db);
  chat.approve(cfg, db, ticket, '');
  await chat.startChat(cfg, db, claimed(db, cfg));
  const first = db.prepare('SELECT * FROM turn').get()!;
  const own = addBatch(db, ticket, { own: true, text: 'Own context received after failed input' });
  peer.finish(String(first.session_id), String(first.prompt_id), '', 'interrupted', undefined, PEER_AT + 1000);
  await chat.collect(cfg, db, claimed(db, cfg));
  const recovery = db.prepare("SELECT * FROM turn WHERE kind='recovery'").get()!;
  expect(JSON.parse(String(recovery.context_ids))).toEqual([own]);
  expect(String(recovery.text)).toContain('Own context received after failed input');
});

test('recovery continuation never merges into or replaces a later parked ordinary forward', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const ticket = proposed(db);
  chat.approve(cfg, db, ticket, '');
  await chat.startChat(cfg, db, claimed(db, cfg));
  const first = db.prepare('SELECT * FROM turn').get()!;
  const laterBatch = addBatch(db, ticket, { text: 'Later parked input' });
  const later = jobs.enqueue(db, 'forward', 'later-parked', { batch_ids: [laterBatch] }, ticket);
  jobs.park(db, later, 'Unrelated later input failure');
  const saved = { ...row(db, 'job', later) };
  peer.finish(String(first.session_id), String(first.prompt_id), '', 'interrupted', undefined, PEER_AT + 1000);
  await chat.collect(cfg, db, claimed(db, cfg));
  expect(row(db, 'job', later)).toEqual(saved);
  const recovery = db.prepare("SELECT * FROM job WHERE key=?").get(`recovery:turn:${first.id}`)!;
  expect(recovery).toBeTruthy();
  expect(recovery.id).not.toBe(later);
  expect(recovery.state).toBe('queued');
});

test('archive rolls back a concurrent new remote execution observed after PATCH, without marking idle', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const old = '2026-11-04T00:00:00.000000Z';
  const ticket = proposed(db, { lifecycle: 'active', approved_at: old, session_id: 'ses_1', last_activity_at: old });
  const session = remoteSession('ses_1', cfg.opencode.directory);
  session.time.created = PEER_AT - 3 * 86400000;
  peer.sessions.set('ses_1', session);
  peer.state.hook = (call) => {
    if (call.method === 'PATCH' && call.body.archived === true) session.time.busy = Date.now();
    return false;
  };
  jobs.enqueue(db, 'archive', 'archive-race', {});
  await chat.archive(cfg, db, claimed(db, cfg));
  expect(peer.sessions.get('ses_1')!.time.archived).toBeUndefined();
  expect(row(db, 'ticket', ticket).archived_at).toBeNull();
  expect(peer.calls.filter((call) => call.method === 'PATCH' && call.body.archived === false)).toHaveLength(1);
});

test('admission and collector enqueue roll back together on real SQLite completion failure, then reconcile after reopen', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let input: number;
  let turn: Record<string, unknown>;
  {
    using db = openDb(path);
    const ticket = proposed(db);
    addBatch(db, ticket);
    chat.approve(cfg, db, ticket, '');
    db.exec("CREATE TRIGGER reject_input_completion BEFORE UPDATE OF state ON job WHEN NEW.state='done' AND NEW.kind='start_chat' BEGIN SELECT RAISE(ABORT,'synthetic local completion failure'); END");
    const job = claimed(db, cfg); input = job.id;
    await chat.startChat(cfg, db, job);
    turn = { ...db.prepare('SELECT * FROM turn').get()! };
    expect(turn.state).toBe('prepared');
    expect(peer.admissions.has(String(turn.prompt_id))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='collect'").get()!.n).toBe(0);
    expect(row(db, 'job', input).state).toBe('queued');
    expect(db.prepare('SELECT state FROM batch').get()!.state).toBe('prepared');
    vi.setSystemTime(new Date(String(row(db, 'job', input).next_at)));
  }
  using restarted = openDb(path);
  restarted.exec('DROP TRIGGER reject_input_completion');
  await chat.startChat(cfg, restarted, claimed(restarted, cfg, 'after-local-failure'));
  expect(row(restarted, 'job', input!).state).toBe('done');
  expect(row(restarted, 'turn', Number(turn!.id)).state).toBe('admitted');
  expect(restarted.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='collect' AND state='queued'").get()!.n).toBe(1);
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
});

test('real SQLite terminal failure rolls back report/refs/timeline/batch/turn, then retries durable rename without replay', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  let ticket: number;
  let turn: Record<string, unknown>;
  {
    using db = openDb(path);
    ticket = proposed(db);
    addBatch(db, ticket);
    chat.approve(cfg, db, ticket, '');
    await chat.startChat(cfg, db, claimed(db, cfg));
    turn = { ...db.prepare('SELECT * FROM turn').get()! };
    peer.finish(String(turn.session_id), String(turn.prompt_id), 'RCA-99\nSTATUS: waiting_them | Atomic completion', 'succeeded', undefined, PEER_AT + 1000);
    db.exec("CREATE TRIGGER reject_terminal BEFORE UPDATE OF state ON turn WHEN NEW.state='done' BEGIN SELECT RAISE(ABORT,'synthetic terminal failure'); END");
    const job = claimed(db, cfg);
    await chat.collect(cfg, db, job);
    expect(row(db, 'ticket', ticket).report).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_ref WHERE key='RCA-99'").get()!.n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM timeline WHERE kind='status'").get()!.n).toBe(0);
    expect(row(db, 'turn', Number(turn.id)).state).toBe('admitted');
    expect(db.prepare('SELECT state FROM batch').get()!.state).toBe('delivered');
    expect(JSON.parse(String(row(db, 'job', job.id).payload))).toHaveProperty('pending_report');
    vi.setSystemTime(new Date(String(row(db, 'job', job.id).next_at)));
  }
  using restarted = openDb(path);
  restarted.exec('DROP TRIGGER reject_terminal');
  peer.state.historyStatus = 503;
  await chat.collect(cfg, restarted, claimed(restarted, cfg, 'after-terminal-failure'));
  expect(row(restarted, 'ticket', ticket!)).toMatchObject({ report: 'waiting_them', report_line: 'Atomic completion' });
  expect(row(restarted, 'turn', Number(turn!.id)).state).toBe('done');
  expect(peer.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
});

test.each(['unreachable', 'duplicate'] as const)('start %s lookup never falls through to creating another session', async (mode) => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const ticket = proposed(db);
  const store = JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()!.detail)).store_id as string;
  if (mode === 'unreachable') peer.state.hook = (_call, response) => { peer.json(response, {}, 503); return true; };
  else {
    for (const id of ['ses_duplicate_1', 'ses_duplicate_2']) peer.sessions.set(id, remoteSession(id, cfg.opencode.directory,
      { inbox_dispatcher: { store_id: store, ticket } }));
  }
  chat.approve(cfg, db, ticket, '');
  const job = claimed(db, cfg);
  await chat.startChat(cfg, db, job);
  expect(row(db, 'job', job.id)).toMatchObject({ state: mode === 'duplicate' ? 'parked' : 'queued', error_class: mode === 'duplicate' ? 'job' : 'dependency' });
  expect(peer.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()!.n).toBe(0);
});

test('old input completing after manual close cannot close a ticket reopened for newer source input, through collector or sync', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  using db = openDb(path);
  const ticket = proposed(db);
  addBatch(db, ticket);
  chat.approve(cfg, db, ticket, '');
  await chat.startChat(cfg, db, claimed(db, cfg));
  const old = db.prepare('SELECT * FROM turn').get()!;
  vi.setSystemTime(new Date('2026-11-06T00:01:00Z'));
  close(db, ticket, 'Manual close marker');
  vi.setSystemTime(new Date('2026-11-06T00:02:00Z'));
  const newer = addBatch(db, ticket, { conversation: 'conversation-1', text: 'New input after closure' });
  expect(route(db, newer).mode).toBe('forward');
  jobs.enqueue(db, 'forward', 'new-input-after-close', { batch_ids: [newer] }, ticket);
  peer.finish(String(old.session_id), String(old.prompt_id), 'STATUS: done | Old request finally completed', 'succeeded', undefined, PEER_AT + 180000);
  vi.setSystemTime(new Date('2026-11-06T00:04:00Z'));
  await chat.collect(cfg, db, claimed(db, cfg));
  expect(row(db, 'ticket', ticket)).toMatchObject({ lifecycle: 'active', report_at: '2026-11-06T00:01:00.000000Z', last_activity_at: '2026-11-06T00:02:00.000000Z' });
  expect(row(db, 'ticket', ticket).report).not.toBe('done');
  jobs.enqueue(db, 'sync', 'old-input-sync', {});
  expect(claimed(db, cfg).kind).toBe('forward');
  await chat.sync(cfg, db, claimed(db, cfg));
  expect(row(db, 'ticket', ticket)).toMatchObject({ lifecycle: 'active', report_at: '2026-11-06T00:01:00.000000Z', last_activity_at: '2026-11-06T00:02:00.000000Z' });
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
});

test('recovery honors configured backoff jitter instead of using a fixed midpoint', async () => {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  cfg.jobs.backoff_jitter = 0.2;
  using db = openDb(path);
  const ticket = proposed(db);
  chat.approve(cfg, db, ticket, '');
  await chat.startChat(cfg, db, claimed(db, cfg));
  const turn = db.prepare('SELECT * FROM turn').get()!;
  peer.finish(String(turn.session_id), String(turn.prompt_id), '', 'failed', { type: 'provider.transport', message: 'Synthetic dependency failure' });
  const random = vi.spyOn(Math, 'random').mockReturnValue(0);
  try {
    await chat.collect(cfg, db, claimed(db, cfg));
    expect(db.prepare("SELECT next_at FROM job WHERE kind='forward' AND state='queued'").get()!.next_at).toBe('2026-11-06T00:00:08.000000Z');
  } finally { random.mockRestore(); }
});
