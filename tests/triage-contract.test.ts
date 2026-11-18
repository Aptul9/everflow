import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as api from '../src/core/kb-agent.ts';
import { openDb } from '../src/core/db.ts';
import { ingest, schedule } from '../src/core/ingest.ts';
import * as jobs from '../src/core/jobs.ts';
import type { Config } from '../src/core/config.ts';
import * as tickets from '../src/core/tickets.ts';
import { decision, kbFixture, provider, scriptedPeer, text, tools, use } from './kb-support.ts';
import { snapshot } from './support.ts';

const AT = '2026-11-06T00:00:00.000000Z';
const effects = ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'batch', 'triage_log', 'turn'];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT)); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const handle = api.handleTriage;

function source(overrides: Record<string, unknown> = {}) {
  return { source: 'outlook', account: 'me@acme.invalid', conversation_id: 'conversation', conversation_title: 'Original title',
    message_id: 'native-1', sender: 'bob@acme.invalid', sender_name: 'Bob', sender_is_me: false,
    sent_at: '2026-11-05T23:50:00Z', text: 'Check RCA-12', ...overrides };
}

function ticket(db: DatabaseSync, fields: Record<string, SQLInputValue> = {}): number {
  const values = { title: 'Synthetic ticket', client: 'acme', created_at: AT, ...fields };
  return Number(db.prepare(`INSERT INTO ticket(${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`)
    .run(...Object.values(values)).lastInsertRowid);
}

function batchJob(db: DatabaseSync, cfg: Config, owner?: number): jobs.Job {
  ingest(db, source());
  if (owner) db.prepare('INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,1,\'primary\',\'rule\',?)').run(owner, AT);
  schedule(db, cfg, AT);
  return jobs.claim(db, cfg, 'triage-worker', AT)!;
}

function jobRow(db: DatabaseSync, job: jobs.Job) { return db.prepare('SELECT * FROM job WHERE id=?').get(job.id)!; }
function input(request: { messages: { content: unknown }[] }) {
  return JSON.parse(String(request.messages[0]!.content)) as { mode: string; context: { conversation_title: string | null; ticket: number | null; messages: { id: number; text: string }[] } };
}

test('triage commits proposal, log, route, refs, timeline, batch and completion together with no approval or session', async () => {
  const { cfg } = kbFixture();
  cfg.chats.enabled = true;
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  const raw = ` \n${JSON.stringify(decision())}\n `;
  const inside: boolean[] = [];
  await using peer = await scriptedPeer(() => { inside.push(db.isTransaction); return { body: text(raw) }; });
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(1);
  expect(inside).toEqual([false]);
  expect(input(peer.requests[0]!)).toMatchObject({ mode: 'new', context: { conversation_title: 'Original title', messages: [{ text: 'Check RCA-12' }] } });
  expect(db.prepare('SELECT lifecycle,session_id,approved_at,proposal FROM ticket').get()).toEqual({ lifecycle: 'proposed', session_id: null, approved_at: null, proposal: 'Inspect logs' });
  expect(db.prepare('SELECT state,outcome,ticket FROM batch').get()).toEqual({ state: 'done', outcome: 'proposed', ticket: 1 });
  expect(db.prepare('SELECT raw,reason FROM triage_log').get()).toEqual({ raw, reason: 'Explicit synthetic request' });
  expect(db.prepare('SELECT key FROM ticket_ref').get()?.key).toBe('RCA-12');
  expect(db.prepare('SELECT kind,"by" FROM ticket_conversation').get()).toEqual({ kind: 'primary', by: 'agent' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM timeline').get()?.n).toBeGreaterThan(1);
  expect(jobRow(db, job).state).toBe('done');
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(1);
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
});

test('triage sees the latest earlier messages of the conversation with send times, oldest first, capped and apart from the batch', async () => {
  const { cfg } = kbFixture();
  cfg.triage.history_messages = 3;
  using db = openDb(cfg.db.path);
  for (const [n, minute] of [[1, '20'], [2, '30'], [3, '40'], [4, '45']] as const) {
    ingest(db, source({ message_id: `earlier-${n}`, sent_at: `2026-11-05T22:${minute}:00Z`, text: n === 4 ? 'x'.repeat(5_000) : `Earlier ${n}`, sender_is_me: n === 3 }));
  }
  db.prepare("INSERT INTO batch(conversation,state,created_at,done_at,outcome) VALUES (1,'done',?,?,'not_on_us')").run(AT, AT);
  db.exec('UPDATE message SET batch=1');
  const job = batchJob(db, cfg);
  await using peer = await scriptedPeer(() => ({ body: text() }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  const { context } = JSON.parse(String(peer.requests[0]!.messages[0]!.content)) as {
    context: { now: string; messages: { text: string }[]; history: { sent_at: string; sender_is_me: boolean; text: string }[] } };
  expect(context.now).toBe(AT);
  expect(context.messages).toMatchObject([{ text: 'Check RCA-12' }]);
  expect(context.history.map((message) => message.sent_at)).toEqual(['2026-11-05T22:30:00.000000Z', '2026-11-05T22:40:00.000000Z', '2026-11-05T22:45:00.000000Z']);
  expect(context.history).toMatchObject([{ text: 'Earlier 2', sender_is_me: false }, { text: 'Earlier 3', sender_is_me: true }, { text: 'x'.repeat(2_000) }]);
  expect(peer.requests[0]!.system).toMatch(/history/);
});

test('end-to-end source, HTTP tool round trip and KB-derived proposal commit under the same leased job', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  const note = '02_Areas/workflows/deploy.md';
  const inside: boolean[] = [];
  await using peer = await scriptedPeer((request, index) => {
    inside.push(db.isTransaction);
    if (index === 0) return { body: tools(use('find-workflow', 'vault_search', { query: 'marker-417' })) };
    if (index === 1) {
      const result = request.messages.at(-1)!.content as { tool_use_id: string; content: string }[];
      const hits = JSON.parse(result[0]!.content) as { path: string }[];
      return { body: tools(use('read-workflow', 'vault_read', { path: hits[0]!.path })) };
    }
    const result = request.messages.at(-1)!.content as { tool_use_id: string; content: string }[];
    const read = JSON.parse(result[0]!.content) as { path: string; text: string };
    const marker = read.text.match(/marker-\d+/)?.[0];
    return { body: text(JSON.stringify(decision({ kb_notes: [read.path], proposal: `Inspect ${marker}` }))) };
  });
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.errors).toEqual([]);
  expect(peer.requests).toHaveLength(3);
  expect(inside).toEqual([false, false, false]);
  expect(db.prepare('SELECT proposal,kb_notes,lifecycle,session_id,approved_at FROM ticket').get())
    .toEqual({ proposal: 'Inspect marker-417', kb_notes: JSON.stringify([note]), lifecycle: 'proposed', session_id: null, approved_at: null });
  expect(db.prepare('SELECT raw FROM triage_log').get()?.raw).toContain('Inspect marker-417');
  expect(jobRow(db, job).state).toBe('done');
  expect(db.prepare('SELECT state,outcome FROM batch').get()).toEqual({ state: 'done', outcome: 'proposed' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
});

test('provider thinking blocks are accepted, echoed unchanged with the tool turn and never parsed as the decision', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  const thinking = { type: 'thinking', thinking: 'Synthetic reasoning, never a decision.', signature: 'synthetic-signature' };
  const call = { ...use('find-workflow'), caller: { type: 'direct' } };
  await using peer = await scriptedPeer((_request, index) => index === 0
    ? { body: { content: [thinking, call], stop_reason: 'tool_use' } }
    : { body: { content: [{ type: 'redacted_thinking', data: 'synthetic-redacted' }, ...text().content], stop_reason: 'end_turn' } });
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.errors).toEqual([]);
  expect(peer.requests).toHaveLength(2);
  expect(peer.requests[1]!.messages.at(-2)).toEqual({ role: 'assistant', content: [thinking, call] });
  expect(jobRow(db, job).state).toBe('done');
  expect(db.prepare('SELECT lifecycle,proposal FROM ticket').get()).toEqual({ lifecycle: 'proposed', proposal: 'Inspect logs' });
  expect(db.prepare("SELECT COUNT(*) AS n FROM triage_log WHERE action='invalid'").get()?.n).toBe(0);
});

test('proposed route is reassessed in update mode using the fresh shared title snapshot', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const owner = ticket(db, { proposal: 'Old proposal' });
  const job = batchJob(db, cfg, owner);
  db.prepare("UPDATE conversation SET title='Fresh title'").run();
  await using peer = await scriptedPeer(() => ({ body: text(JSON.stringify(decision({ action: 'update', ticket: owner }))) }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(input(peer.requests[0]!)).toMatchObject({ mode: 'update', context: { ticket: owner, conversation_title: 'Fresh title' } });
  expect(JSON.parse(String(jobRow(db, job).payload)).conversation_title).toBe('Fresh title');
  expect(db.prepare('SELECT proposal,lifecycle,approved_at FROM ticket').get()).toEqual({ proposal: 'Inspect logs', lifecycle: 'proposed', approved_at: null });
});

test('current closed rule route skips the model and preserves proposal/approval markers', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const owner = ticket(db, { proposal: 'Kept proposal' });
  const job = batchJob(db, cfg, owner);
  // Closed the next day: same-day input no chat turn carried would reopen the chat instead
  db.prepare('UPDATE ticket SET lifecycle=?,approved_at=?,session_id=?,closed_at=? WHERE id=?').run('done', AT, 'existing-session', '2026-11-07T00:00:01Z', owner);
  await using peer = await scriptedPeer(() => ({ body: text() }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(0);
  expect(jobRow(db, job).state).toBe('done');
  expect(db.prepare('SELECT outcome FROM batch').get()?.outcome).toBe('closed');
  expect(db.prepare('SELECT proposal,session_id,approved_at FROM ticket').get()).toEqual({ proposal: 'Kept proposal', session_id: 'existing-session', approved_at: AT });
  expect(db.prepare('SELECT COUNT(*) AS n FROM triage_log').get()?.n).toBe(0);
});

function runningTicket(db: DatabaseSync, fields: Record<string, SQLInputValue> = {}): number {
  return ticket(db, { lifecycle: 'active', approved_at: AT, session_id: 'running-session', proposal: 'Kept proposal', report: 'waiting_them',
    report_line: 'Waiting for Bob to mount /data', ...fields });
}

test('a follow-up of a running ticket chat is judged against that ticket alone, with its record and the follow-up rules', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  ticket(db, { title: 'Unrelated open ticket', lifecycle: 'active', approved_at: AT });
  const owner = runningTicket(db);
  const job = batchJob(db, cfg, owner);
  expect(JSON.parse(String(jobRow(db, job).payload))).toMatchObject({ mode: 'follow', ticket: owner, candidates: [], candidate_ids: [owner] });
  await using peer = await scriptedPeer(() => ({ body: text(JSON.stringify(decision({ action: 'update', ticket: owner, title: 'Synthetic ticket', summary: '', ask: '', proposal: '' }))) }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  const offered = JSON.parse(String(peer.requests[0]!.messages[0]!.content)) as { mode: string; candidates: { id: number }[]; context: { active_ticket: { id: number; last_report: string } } };
  expect(offered).toMatchObject({ mode: 'follow', candidates: [{ id: owner }], context: { active_ticket: { id: owner, last_report: 'Waiting for Bob to mount /data' } } });
  expect(peer.requests[0]!.system).toMatch(/When mode is follow/);
  expect(jobRow(db, job).state).toBe('done');
  expect(db.prepare('SELECT state,outcome,ticket FROM batch').get()).toEqual({ state: 'pending', outcome: 'routed', ticket: owner });
  expect(db.prepare('SELECT proposal,lifecycle FROM ticket WHERE id=?').get(owner)).toEqual({ proposal: 'Kept proposal', lifecycle: 'active' });
  expect(db.prepare("SELECT body FROM timeline WHERE ticket=? AND kind='triage'").get(owner)?.body).toBe('Explicit synthetic request');
});

test.each([
  { name: 'a sure skip keeps it off the chat', confidence: 0.9, outcome: 'not_on_us', state: 'done' },
  { name: 'an unsure skip still forwards it', confidence: 0.5, outcome: 'routed', state: 'pending' },
])('follow-up triage: $name', async ({ confidence, outcome, state }) => {
  const { cfg } = kbFixture();
  cfg.chats.enabled = true;
  using db = openDb(cfg.db.path);
  const owner = runningTicket(db);
  const job = batchJob(db, cfg, owner);
  await using peer = await scriptedPeer(() => ({ body: text(JSON.stringify(decision({ on_us: false, action: 'skip', title: '', reason: 'Automatic out-of-office reply', confidence }))) }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(jobRow(db, job).state).toBe('done');
  expect(db.prepare('SELECT state,outcome,ticket FROM batch').get()).toEqual({ state, outcome, ticket: owner });
  expect(db.prepare('SELECT action,reason FROM triage_log').get()).toEqual({ action: 'skip', reason: 'Automatic out-of-office reply' });
  expect(db.prepare("SELECT body FROM timeline WHERE ticket=? AND kind='triage'").get(owner)?.body).toBe('Automatic out-of-office reply');
  expect(db.prepare('SELECT lifecycle,report FROM ticket WHERE id=?').get(owner)).toEqual({ lifecycle: 'active', report: 'waiting_them' });
  schedule(db, cfg, AT);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='forward'").get()?.n).toBe(outcome === 'routed' ? 1 : 0);
  if (outcome === 'not_on_us') {
    expect(tickets.makeTicket(db, 1, AT)).toBe(owner);
    expect(schedule(db, cfg, AT)).toHaveLength(1);
    expect(db.prepare("SELECT ticket,json_extract(payload,'$.batch_ids') AS batches FROM job WHERE kind='forward'").get()).toEqual({ ticket: owner, batches: '[1]' });
  }
});

test('follow-up triage: a different request in the running chat gets its own proposal and the chat keeps its ticket', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const owner = runningTicket(db);
  const job = batchJob(db, cfg, owner);
  await using peer = await scriptedPeer(() => ({ body: text(JSON.stringify(decision({ title: 'Open the firewall for the backup' }))) }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  const created = Number(db.prepare('SELECT ticket FROM batch').get()!.ticket);
  expect(created).not.toBe(owner);
  expect(db.prepare('SELECT title,lifecycle FROM ticket WHERE id=?').get(created)).toEqual({ title: 'Open the firewall for the backup', lifecycle: 'proposed' });
  expect(db.prepare('SELECT state,outcome FROM batch').get()).toEqual({ state: 'done', outcome: 'proposed' });
  expect(db.prepare("SELECT ticket,kind FROM ticket_conversation WHERE kind IN ('primary','linked')").all()).toEqual([{ ticket: owner, kind: 'primary' }]);
});

test('follow-up triage: an answer still invalid after repair forwards the input instead of parking the running chat', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const owner = runningTicket(db);
  const job = batchJob(db, cfg, owner);
  await using peer = await scriptedPeer((_request, index) => ({ body: text(index ? 'invalid repaired decision' : 'invalid initial decision') }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(2);
  expect(jobRow(db, job)).toMatchObject({ state: 'done', attempts: 0, error_class: null });
  expect(db.prepare('SELECT state,outcome,ticket FROM batch').get()).toEqual({ state: 'pending', outcome: 'routed', ticket: owner });
  expect(db.prepare('SELECT action,raw FROM triage_log').all()).toEqual([{ action: 'invalid', raw: 'invalid repaired decision' }]);
  expect(db.prepare("SELECT actor,body FROM timeline WHERE ticket=? AND kind='triage'").get(owner)).toMatchObject({ actor: 'rule', body: expect.stringMatching(/^Forwarded without a triage decision: /) });
});

test.each([0.75, 0.749999])('triage applies configured confidence threshold at %s without creating a chat', async (confidence) => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const candidate = ticket(db, { lifecycle: 'active', approved_at: AT, session_id: 'keep-session' });
  const job = batchJob(db, cfg);
  await using peer = await scriptedPeer(() => ({ body: text(JSON.stringify(decision({ action: 'update', ticket: candidate, confidence }))) }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(jobRow(db, job).state).toBe('done');
  expect(db.prepare('SELECT ticket FROM batch').get()?.ticket).toBe(confidence >= 0.75 ? candidate : 2);
  if (confidence < 0.75) expect(db.prepare('SELECT maybe_ticket,session_id,approved_at FROM ticket WHERE id=2').get()).toEqual({ maybe_ticket: candidate, session_id: null, approved_at: null });
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
});

test('a changed shared title discards the old response; defer/reclaim makes a genuinely fresh request', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  await using peer = await scriptedPeer((_request, index) => {
    if (!index) db.prepare("UPDATE conversation SET title='New source title'").run();
    return { body: text(JSON.stringify(decision({ proposal: index ? 'Fresh proposal' : 'Stale proposal' }))) };
  });
  const options = { providers: { first: provider(peer.baseURL) } };
  await handle(cfg, db, job, options);
  expect(jobRow(db, job)).toMatchObject({ state: 'queued', attempts: 0, failures: 0 });
  expect(JSON.parse(String(jobRow(db, job).payload)).conversation_title).toBe('Original title');
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM triage_log').get()?.n).toBe(0);
  const fresh = jobs.claim(db, cfg, 'fresh-worker', AT)!;
  expect(fresh.lease_token).not.toBe(job.lease_token);
  await handle(cfg, db, fresh, options);
  expect(peer.requests.map((request) => input(request).context.conversation_title)).toEqual(['Original title', 'New source title']);
  expect(db.prepare('SELECT proposal FROM ticket').get()?.proposal).toBe('Fresh proposal');
  expect(jobRow(db, fresh).state).toBe('done');
});

test.each([undefined, 17, null, ''])('reoffers exact current nullable metadata before I/O rather than trusting legacy scope %s', async (legacy) => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  if (legacy === null || legacy === '') db.prepare('UPDATE conversation SET title=?').run(legacy);
  const payload = { ...job.payload, conversation_title: legacy };
  db.prepare('UPDATE job SET payload=? WHERE id=?').run(JSON.stringify(payload), job.id);
  const seen: unknown[] = [];
  await using peer = await scriptedPeer((request) => {
    seen.push(JSON.parse(String(jobRow(db, job).payload)).conversation_title, input(request).context.conversation_title);
    return { body: text() };
  });
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(seen).toEqual([legacy === null || legacy === '' ? legacy : 'Original title', legacy === null || legacy === '' ? legacy : 'Original title']);
  expect(jobRow(db, job).state).toBe('done');
});

test('source edit during I/O retries current version, without absorbing later own-only input', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  await using peer = await scriptedPeer((_request, index) => {
    if (!index) {
      vi.setSystemTime(new Date('2026-11-06T00:00:01Z'));
      ingest(db, source({ text: 'Edited source text' }));
      ingest(db, source({ message_id: 'later-own', sender_is_me: true, sender: 'me@acme.invalid', text: 'Later own context' }));
    }
    return { body: text() };
  });
  const options = { providers: { first: provider(peer.baseURL) } };
  await handle(cfg, db, job, options);
  expect(jobRow(db, job).state).toBe('queued');
  const fresh = jobs.claim(db, cfg, 'fresh-worker')!;
  await handle(cfg, db, fresh, options);
  expect(input(peer.requests[1]!).context.messages.map((message) => message.text)).toEqual(['Edited source text']);
  expect(db.prepare("SELECT batch FROM message WHERE native_id='later-own'").get()?.batch).toBeNull();
  expect(jobRow(db, fresh).state).toBe('done');
});

test.each(['fallback', 'repair'])('%s reoffers/persists fresh scope before its request and discards old transcript', async (kind) => {
  const { cfg } = kbFixture();
  if (kind === 'fallback') cfg.triage.providers = ['first', 'second'];
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  const seen: unknown[] = [];
  await using peer = await scriptedPeer((request, index) => {
    seen.push([input(request).context.conversation_title, JSON.parse(String(jobRow(db, job).payload)).conversation_title, db.isTransaction]);
    if (!index) {
      db.prepare("UPDATE conversation SET title='Changed before retry'").run();
      return kind === 'fallback' ? { status: 503 } : { body: text('invalid JSON') };
    }
    return { body: text() };
  });
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL), second: provider(peer.baseURL) } });
  expect(seen).toEqual([['Original title', 'Original title', false], ['Changed before retry', 'Changed before retry', false]]);
  expect(jobRow(db, job).state).toBe('done');
});

test('changing persisted scope after I/O began never retrofits current metadata onto the stale response', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  await using peer = await scriptedPeer(() => {
    db.prepare("UPDATE conversation SET title='Changed during I/O'").run();
    const fresh = tickets.assessmentPayload(db, cfg, Number(job.payload.batch), tickets.route(db, Number(job.payload.batch)));
    db.prepare('UPDATE job SET payload=? WHERE id=?').run(JSON.stringify(fresh), job.id);
    return { body: text(JSON.stringify(decision({ proposal: 'Must not apply' }))) };
  });
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(jobRow(db, job)).toMatchObject({ state: 'queued', attempts: 0 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM triage_log').get()?.n).toBe(0);
});

test('a proposal moved during I/O is not overwritten by the old target assessment', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const old = ticket(db, { proposal: 'Old kept proposal' });
  const target = ticket(db, { proposal: 'Target kept proposal' });
  const job = batchJob(db, cfg, old);
  await using peer = await scriptedPeer(() => {
    db.prepare("UPDATE ticket_conversation SET kind='context' WHERE ticket=?").run(old);
    db.prepare('INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,1,\'linked\',\'you\',?)').run(target, AT);
    return { body: text(JSON.stringify(decision({ action: 'update', ticket: old, proposal: 'Stale replacement' }))) };
  });
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(jobRow(db, job)).toMatchObject({ state: 'queued', attempts: 0, failures: 0 });
  expect(db.prepare('SELECT proposal FROM ticket ORDER BY id').all()).toEqual([{ proposal: 'Old kept proposal' }, { proposal: 'Target kept proposal' }]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM triage_log').get()?.n).toBe(0);
});

test('approval during provider I/O routes late input without rewriting approved proposal', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const owner = ticket(db, { proposal: 'Approved proposal' });
  const job = batchJob(db, cfg, owner);
  await using peer = await scriptedPeer(() => {
    db.prepare("UPDATE ticket SET lifecycle='active',approved_at=?,session_id='approved-session' WHERE id=?").run(AT, owner);
    return { body: text(JSON.stringify(decision({ action: 'update', ticket: owner, proposal: 'Late stale proposal' }))) };
  });
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(1);
  expect(db.prepare('SELECT proposal,lifecycle,approved_at,session_id FROM ticket').get()).toEqual({ proposal: 'Approved proposal', lifecycle: 'active', approved_at: AT, session_id: 'approved-session' });
  expect(jobRow(db, job).state).toBe('done');
  expect(db.prepare('SELECT outcome FROM batch').get()?.outcome).toBe('routed');
});

test('expired/reclaimed lease rejects every late local effect and cannot touch its new owner', async () => {
  const { cfg } = kbFixture();
  cfg.jobs.lease_seconds = 5;
  cfg.jobs.renew_seconds = 1;
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  let before: ReturnType<typeof snapshot>;
  let reclaimed: jobs.Job;
  await using peer = await scriptedPeer(() => {
    vi.setSystemTime(new Date('2026-11-06T00:00:06Z'));
    reclaimed = jobs.claim(db, cfg, 'new-owner')!;
    before = snapshot(db, [...effects, 'job']);
    return { body: text() };
  });
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(1);
  expect(snapshot(db, [...effects, 'job'])).toEqual(before!);
  expect(jobRow(db, reclaimed!).run_id).toBe('new-owner');
});

test.each(['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'triage_log', 'batch', 'job'])('injected %s write failure rolls back all completion effects', async (table) => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  const before = snapshot(db, effects);
  const operation = table === 'batch' || table === 'job' ? 'UPDATE' : 'INSERT';
  const condition = table === 'batch' ? "WHEN NEW.outcome='proposed'" : table === 'job' ? "WHEN NEW.state='done'" : '';
  db.exec(`CREATE TRIGGER inject_failure BEFORE ${operation} ON "${table}" ${condition} BEGIN SELECT RAISE(ABORT, 'injected ${table} write failure'); END`);
  await using peer = await scriptedPeer(() => ({ body: text() }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(1);
  expect(snapshot(db, effects)).toEqual(before);
  expect(jobRow(db, job).state).toBe('queued');
  expect(jobRow(db, job).last_error).toContain(`injected ${table} write failure`);
});

test('invalid final decision parks atomically with raw evidence and parse error, and an explicit retry can succeed', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  const raw = 'still invalid raw';
  await using peer = await scriptedPeer((_request, index) => ({ body: index < 2 ? text(index ? raw : 'first invalid raw') : text() }));
  const options = { providers: { first: provider(peer.baseURL) } };
  await handle(cfg, db, job, options);
  expect(jobRow(db, job)).toMatchObject({ state: 'parked', error_class: 'job', attempts: 1 });
  const saved = JSON.parse(String(jobRow(db, job).payload)).assessment_error;
  expect(saved).toMatchObject({ raw, parse_error: expect.any(String), responses: [{ raw: 'first invalid raw' }, { raw }] });
  expect(db.prepare('SELECT action,raw,reason FROM triage_log').get()).toMatchObject({ action: 'invalid', raw, reason: saved.parse_error });
  for (const table of ['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'turn']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
  jobs.retry(db, job.id);
  const retry = jobs.claim(db, cfg, 'retry-worker')!;
  await handle(cfg, db, retry, options);
  expect(jobRow(db, retry).state).toBe('done');
  expect(db.prepare('SELECT action FROM triage_log ORDER BY id').all()).toEqual([{ action: 'invalid' }, { action: 'new' }]);
});

test('all dependencies unavailable backs off to earliest route floor without consuming attempts', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['first', 'second'];
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  await using peer = await scriptedPeer((_request, index) => ({ status: index ? 503 : 429, headers: { 'retry-after': index ? '30' : '120' } }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL), second: provider(peer.baseURL) } });
  expect(jobRow(db, job)).toMatchObject({ state: 'queued', error_class: 'dependency', attempts: 0, failures: 1, next_at: '2026-11-06T00:00:30.000000Z' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n).toBe(0);
});

test('external cancellation defers without attempts, failures, health damage or partial effects', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  const controller = new AbortController();
  const before = snapshot(db, effects);
  const transport: typeof fetch = async () => { controller.abort(new Error('Worker stopping')); throw controller.signal.reason; };
  await handle(cfg, db, job, { signal: controller.signal, fetch: transport, providers: { first: provider('http://synthetic.invalid') } });
  expect(jobRow(db, job)).toMatchObject({ state: 'queued', attempts: 0, failures: 0 });
  expect(snapshot(db, effects)).toEqual(before);
  expect(db.prepare('SELECT COUNT(*) AS n FROM health').get()?.n).toBe(0);
});

test('a title edit through a different historical source batch invalidates the current offer', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  ingest(db, source({ message_id: 'historical', text: 'Historical source' }));
  db.prepare("INSERT INTO batch(conversation,state,created_at,outcome) VALUES (1,'done',?,'not_on_us')").run(AT);
  db.prepare('UPDATE message SET batch=1').run();
  const job = batchJob(db, cfg);
  const originalVersions = JSON.parse(String(jobRow(db, job).payload)).message_versions;
  await using peer = await scriptedPeer((_request, index) => {
    if (!index) ingest(db, source({ message_id: 'historical', text: 'Historical source', conversation_title: 'Changed historical title' }));
    return { body: text(JSON.stringify(decision({ proposal: index ? 'Fresh assessment' : 'Old assessment' }))) };
  });
  const options = { providers: { first: provider(peer.baseURL) } };
  await handle(cfg, db, job, options);
  expect(jobRow(db, job)).toMatchObject({ state: 'queued', attempts: 0, failures: 0 });
  expect(JSON.parse(String(jobRow(db, job).payload)).message_versions).toEqual(originalVersions);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n).toBe(0);
  await handle(cfg, db, jobs.claim(db, cfg, 'historical-title-retry')!, options);
  expect(peer.requests.map((request) => input(request).context.conversation_title)).toEqual(['Original title', 'Changed historical title']);
  expect(db.prepare('SELECT proposal FROM ticket').get()?.proposal).toBe('Fresh assessment');
});

test('lease loss inside a completion statement rolls back even writes already performed', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const job = batchJob(db, cfg);
  const before = snapshot(db, [...effects, 'job']);
  db.exec("CREATE TRIGGER lose_lease AFTER INSERT ON triage_log BEGIN UPDATE job SET lease_token='stolen' WHERE kind='triage'; END");
  await using peer = await scriptedPeer(() => ({ body: text() }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(1);
  expect(snapshot(db, [...effects, 'job'])).toEqual(before);
});

test('invalid repair superseded by closed rules completes without accepting the invalid decision', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const owner = ticket(db, { proposal: 'Kept original proposal' });
  const job = batchJob(db, cfg, owner);
  let offered = '';
  await using peer = await scriptedPeer((_request, index) => {
    if (index === 1) {
      offered = String(jobRow(db, job).payload);
      db.prepare('UPDATE ticket SET lifecycle=?,approved_at=?,session_id=?,closed_at=? WHERE id=?')
        .run('done', AT, 'synthetic-approved-session', '2026-11-07T00:00:01.000000Z', owner);
    }
    return { body: text(index ? 'invalid repaired decision' : 'invalid initial decision') };
  });
  const statements = vi.spyOn(db, 'prepare');
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(2);
  expect(peer.errors).toEqual([]);
  expect(jobRow(db, job)).toMatchObject({ state: 'done', attempts: 0, failures: 0, error_class: null, last_error: null });
  expect(String(jobRow(db, job).payload)).toBe(offered);
  expect(db.prepare('SELECT state,outcome,ticket FROM batch').get()).toEqual({ state: 'done', outcome: 'closed', ticket: owner });
  expect(db.prepare('SELECT proposal,lifecycle,session_id,approved_at FROM ticket WHERE id=?').get(owner)).toEqual({
    proposal: 'Kept original proposal', lifecycle: 'done', session_id: 'synthetic-approved-session', approved_at: AT,
  });
  expect(db.prepare('SELECT action FROM triage_log').all()).toEqual([]);
  expect(statements.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO health(dependency,state,since,last_ok'))).toHaveLength(2);
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(1);
});

test('invalid repair after approval forwards the follow-up to the new chat without accepting the invalid decision', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const owner = ticket(db, { proposal: 'Kept original proposal' });
  const job = batchJob(db, cfg, owner);
  await using peer = await scriptedPeer((_request, index) => {
    if (index === 1) db.prepare('UPDATE ticket SET lifecycle=?,approved_at=?,session_id=? WHERE id=?').run('active', AT, 'synthetic-approved-session', owner);
    return { body: text(index ? 'invalid repaired decision' : 'invalid initial decision') };
  });
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(2);
  expect(jobRow(db, job)).toMatchObject({ state: 'done', attempts: 0, failures: 0, error_class: null, last_error: null });
  expect(db.prepare('SELECT state,outcome,ticket FROM batch').get()).toEqual({ state: 'pending', outcome: 'routed', ticket: owner });
  expect(db.prepare('SELECT proposal,lifecycle FROM ticket WHERE id=?').get(owner)).toEqual({ proposal: 'Kept original proposal', lifecycle: 'active' });
  expect(db.prepare('SELECT action FROM triage_log').all()).toEqual([{ action: 'invalid' }]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
});

test('invalid repair after a move to a running ticket defers for a fresh follow-up assessment', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const owner = ticket(db, { proposal: 'Kept original proposal' });
  const target = runningTicket(db, { proposal: 'Kept target proposal' });
  const job = batchJob(db, cfg, owner);
  await using peer = await scriptedPeer((_request, index) => {
    if (index === 1) {
      db.prepare("UPDATE ticket_conversation SET kind='context' WHERE ticket=?").run(owner);
      db.prepare('INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,1,\'linked\',\'you\',?)').run(target, AT);
    }
    return { body: index < 2 ? text('invalid obsolete decision') : text(JSON.stringify(decision({ action: 'update', ticket: target }))) };
  });
  const options = { providers: { first: provider(peer.baseURL) } };
  await handle(cfg, db, job, options);
  expect(jobRow(db, job)).toMatchObject({ state: 'queued', attempts: 0, failures: 0 });
  expect(db.prepare('SELECT action FROM triage_log').all()).toEqual([]);
  await handle(cfg, db, jobs.claim(db, cfg, 'moved-running-retry')!, options);
  expect(input(peer.requests[2]!)).toMatchObject({ mode: 'follow', context: { ticket: target } });
  expect(db.prepare('SELECT state,outcome,ticket FROM batch').get()).toEqual({ state: 'pending', outcome: 'routed', ticket: target });
  expect(db.prepare('SELECT proposal FROM ticket ORDER BY id').all()).toEqual([{ proposal: 'Kept original proposal' }, { proposal: 'Kept target proposal' }]);
});

test('invalid repair for a still-proposed route continues parking with original raw evidence', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const owner = ticket(db, { proposal: 'Kept proposed fields' });
  const job = batchJob(db, cfg, owner);
  await using peer = await scriptedPeer((_request, index) => ({ body: text(index ? 'invalid proposed repair' : 'invalid proposed initial') }));
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(2);
  expect(jobRow(db, job)).toMatchObject({ state: 'parked', error_class: 'job', attempts: 1, failures: 1 });
  expect(JSON.parse(String(jobRow(db, job).payload)).assessment_error).toMatchObject({ raw: 'invalid proposed repair', parse_error: expect.any(String),
    responses: [{ raw: 'invalid proposed initial' }, { raw: 'invalid proposed repair' }] });
  expect(db.prepare('SELECT action,raw FROM triage_log').all()).toEqual([{ action: 'invalid', raw: 'invalid proposed repair' }]);
  expect(db.prepare('SELECT proposal,lifecycle,approved_at,session_id FROM ticket').get()).toEqual({ proposal: 'Kept proposed fields', lifecycle: 'proposed', approved_at: null, session_id: null });
  expect(db.prepare('SELECT state,outcome FROM batch').get()).toEqual({ state: 'pending', outcome: 'triage' });
});

test('invalid repair after movement to another proposal defers for a fresh assessment instead of parking or overwriting', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const owner = ticket(db, { proposal: 'Kept original proposal' });
  const target = ticket(db, { proposal: 'Kept target proposal' });
  const job = batchJob(db, cfg, owner);
  await using peer = await scriptedPeer((_request, index) => {
    if (index === 1) {
      db.prepare("UPDATE ticket_conversation SET kind='context' WHERE ticket=?").run(owner);
      db.prepare('INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,1,\'linked\',\'you\',?)').run(target, AT);
    }
    return { body: index < 2 ? text('invalid obsolete proposal decision') : text(JSON.stringify(decision({ action: 'update', ticket: target, proposal: 'Fresh target proposal' }))) };
  });
  const options = { providers: { first: provider(peer.baseURL) } };
  await handle(cfg, db, job, options);
  expect(jobRow(db, job)).toMatchObject({ state: 'queued', attempts: 0, failures: 0 });
  expect(db.prepare('SELECT proposal FROM ticket ORDER BY id').all()).toEqual([{ proposal: 'Kept original proposal' }, { proposal: 'Kept target proposal' }]);
  expect(db.prepare('SELECT action FROM triage_log').all()).toEqual([]);
  await handle(cfg, db, jobs.claim(db, cfg, 'moved-proposal-retry')!, options);
  expect(peer.requests).toHaveLength(3);
  expect(input(peer.requests[2]!)).toMatchObject({ mode: 'update', context: { ticket: target } });
  expect(db.prepare('SELECT proposal FROM ticket ORDER BY id').all()).toEqual([{ proposal: 'Kept original proposal' }, { proposal: 'Fresh target proposal' }]);
  expect(jobRow(db, job).state).toBe('done');
});

test('invalid repair after approval cannot complete under a reclaimed lease; the new owner judges the follow-up itself', async () => {
  const { cfg } = kbFixture();
  cfg.jobs.lease_seconds = 5;
  cfg.jobs.renew_seconds = 1;
  using db = openDb(cfg.db.path);
  const owner = ticket(db, { proposal: 'Kept approved fields' });
  const job = batchJob(db, cfg, owner);
  let current: jobs.Job;
  let before: ReturnType<typeof snapshot>;
  await using peer = await scriptedPeer((_request, index) => {
    if (index === 1) {
      vi.setSystemTime(new Date('2026-11-06T00:00:06Z'));
      db.prepare("UPDATE ticket SET lifecycle='active',approved_at=?,session_id='synthetic-approved-session' WHERE id=?").run('2026-11-06T00:00:06.000000Z', owner);
      current = jobs.claim(db, cfg, 'new-rule-owner')!;
      before = snapshot(db, [...effects, 'job']);
    }
    return { body: text('invalid decision') };
  });
  const options = { providers: { first: provider(peer.baseURL) } };
  await handle(cfg, db, job, options);
  expect(peer.requests).toHaveLength(2);
  expect(snapshot(db, [...effects, 'job'])).toEqual(before!);
  expect(jobRow(db, current!)).toMatchObject({ state: 'running', run_id: 'new-rule-owner', attempts: 0 });
  await handle(cfg, db, current!, options);
  expect(peer.requests).toHaveLength(4);
  expect(input(peer.requests[2]!)).toMatchObject({ mode: 'follow', context: { ticket: owner } });
  expect(jobRow(db, current!).state).toBe('done');
  expect(db.prepare('SELECT state,outcome FROM batch').get()).toEqual({ state: 'pending', outcome: 'routed' });
  expect(db.prepare('SELECT action FROM triage_log').all()).toEqual([{ action: 'invalid' }]);
});

test('lease loss inside obsolete invalid rule completion rolls back every rule write', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const owner = ticket(db, { proposal: 'Kept approved fields' });
  const job = batchJob(db, cfg, owner);
  db.exec(`CREATE TRIGGER lose_rule_lease AFTER UPDATE OF outcome ON batch WHEN NEW.outcome='routed' BEGIN UPDATE job SET lease_token='stolen' WHERE id=${job.id}; END`);
  let before: ReturnType<typeof snapshot>;
  await using peer = await scriptedPeer((_request, index) => {
    if (index === 1) {
      db.prepare("UPDATE ticket SET lifecycle='active',approved_at=?,session_id='synthetic-approved-session' WHERE id=?").run(AT, owner);
      before = snapshot(db, [...effects, 'job']);
    }
    return { body: text('invalid decision') };
  });
  await handle(cfg, db, job, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(2);
  expect(snapshot(db, [...effects, 'job'])).toEqual(before!);
  expect(jobRow(db, job)).toMatchObject({ state: 'running', attempts: 0, failures: 0, lease_token: job.lease_token });
});
