import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { loadConfig } from '../src/dispatcher/config.ts';
import { openDb } from '../src/dispatcher/db.ts';
import { ingest, schedule, sourceStart } from '../src/dispatcher/ingest.ts';
import { createSourceReader, validateRuntimeConfig } from '../src/dispatcher/runtime.ts';
import { dismiss, makeTicket, mute, MUTE_FOREVER, muteTicket, TicketError } from '../src/dispatcher/tickets.ts';
import { actionPost } from '../src/web/api.ts';
import { initialize, release } from '../src/web/instance.ts';
import { readState } from '../src/web/state.ts';
import { scratch } from './support.ts';
import { webFixture } from './web-fixture.ts';

const AT = '2026-11-06T10:00:00.000000Z';
const later = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
const line = (value: unknown) => Buffer.from(JSON.stringify(value));

function instance(toml = '') {
  const files = scratch('workdesk-switch-');
  writeFileSync(files.config, `[db]\npath = "fixture.db"\n[tickets]\nenabled = true\n${toml}`);
  return { ...files, cfg: loadConfig(files.config) };
}

function message(account: string, id: string, extra: Record<string, unknown> = {}) {
  return { source: 'teams', account, conversation_id: `chat-${account}`, conversation_title: `Chat ${account}`, message_id: id, sender: 'oid-third-party',
    sender_name: 'Third party', sender_is_me: false, sent_at: AT, text: `Synthetic ${id}`, attachments: [], ref: {}, ...extra };
}

function storedAccounts(db: DatabaseSync): string[] {
  return db.prepare('SELECT DISTINCT c.account FROM message m JOIN conversation c ON c.id=m.conversation ORDER BY c.account').all().map((row) => String(row.account));
}

test('a source account list stores only listed accounts and keeps checkpoint coverage for every account', () => {
  const f = instance('[sources.teams]\nenabled = true\naccounts = [" On@Example.invalid "]\n');
  using db = openDb(f.path);
  sourceStart(db, f.cfg, 'teams', AT);
  const reader = createSourceReader(db, f.cfg, 'teams');
  expect(reader.stdout(line({ source: 'teams', accounts: ['on@example.invalid', 'off@example.invalid'] }))).toBe(true);
  expect(reader.stdout(line(message('Off@example.invalid', 'off-1')))).toBe(false);
  expect(reader.stdout(line(message('on@example.invalid', 'on-1')))).toBe(true);
  expect(storedAccounts(db)).toEqual(['on@example.invalid']);
  expect(reader.stdout(line({ source: 'teams', checkpoint: later(1), accounts: ['on@example.invalid', 'off@example.invalid'] }))).toBe(true);
  expect(db.prepare("SELECT account,since FROM cursor WHERE source='teams' AND account<>'*' ORDER BY account").all().map((row) => ({ ...row }))).toEqual([
    { account: 'off@example.invalid', since: '2026-11-06T10:01:00.000000Z' }, { account: 'on@example.invalid', since: '2026-11-06T10:01:00.000000Z' }]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM quarantine').get()!.n).toBe(0);
  const health = Object.fromEntries(readState(db, f.cfg, new Date(later(2))).health.map((item) => [item.dependency, item.state]));
  expect(health['teams:off@example.invalid']).toBe('disabled');
  expect(health['teams:on@example.invalid']).toBe('ok');

  const all = instance('[sources.teams]\nenabled = true\n');
  using every = openDb(all.path);
  sourceStart(every, all.cfg, 'teams', AT);
  const open = createSourceReader(every, all.cfg, 'teams');
  for (const account of ['on@example.invalid', 'off@example.invalid']) expect(open.stdout(line(message(account, `${account}-1`)))).toBe(true);
  expect(storedAccounts(every)).toEqual(['off@example.invalid', 'on@example.invalid']);
});

test('a source switched off in config reads disabled and the source-wide cursor is no account', () => {
  const f = instance('[sources.teams]\nenabled = false\n[sources.teamsrelay]\nenabled = true\naccounts = ["on@example.invalid"]\n');
  using db = openDb(f.path);
  const cursor = db.prepare('INSERT INTO cursor(source,account,since) VALUES (?,?,?)');
  for (const [source, account] of [['teams', '*'], ['teams', 'on@example.invalid'], ['teamsrelay', '*'], ['teamsrelay', 'on@example.invalid'], ['teamsrelay', 'off@example.invalid']]) cursor.run(source!, account!, AT);
  const health = db.prepare('INSERT INTO health(dependency,state,since) VALUES (?,?,?)');
  for (const [dependency, state] of [['teams', 'stopped'], ['teams:on@example.invalid', 'ok'], ['teamsrelay', 'ok'], ['teamsrelay:on@example.invalid', 'ok']]) health.run(dependency!, state!, AT);
  const states = Object.fromEntries(readState(db, f.cfg, new Date(later(2))).health.map((item) => [item.dependency, item.state]));
  expect(states).toMatchObject({ teams: 'disabled', 'teams:on@example.invalid': 'disabled', teamsrelay: 'ok', 'teamsrelay:on@example.invalid': 'ok', 'teamsrelay:off@example.invalid': 'disabled', outlook: 'disabled' });
  expect(states).not.toHaveProperty('teams:*');
  expect(states).not.toHaveProperty('teamsrelay:*');
});

test('an invalid source account list fails runtime validation', () => {
  const f = instance();
  for (const accounts of [['*'], [''], 'me@example.invalid', ['line\nbreak@example.invalid']]) {
    expect(() => validateRuntimeConfig({ ...f.cfg, sources: { teams: { enabled: false, accounts } } }, process.env.TEST_BUILD_RECEIPT!)).toThrow('source.config');
  }
});

test('opening an earlier v2 database adds the mute column in place, and the page refuses it before that', () => {
  const f = instance();
  {
    using db = openDb(f.path);
    ingest(db, message('me@example.invalid', 'm1'));
    db.exec('ALTER TABLE conversation DROP COLUMN muted_until');
  }
  const current = { config: f.cfg, configPath: f.cfg._config_path, port: 12347, token: 'c'.repeat(64) };
  expect(() => initialize(current)).toThrow('Web instance requires an initialized current database');
  using db = openDb(f.path);
  expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(2);
  expect(db.prepare('SELECT title,muted_until FROM conversation').all().map((row) => ({ ...row }))).toEqual([{ title: 'Chat me@example.invalid', muted_until: null }]);
  initialize(current);
  release(current);
});

test('opening an earlier v2 database adds the batch and ticket clear columns in place, and the page refuses it before that', () => {
  const f = instance();
  {
    using db = openDb(f.path);
    ingest(db, message('me@example.invalid', 'm1'));
    schedule(db, f.cfg, later(10));
    db.exec('ALTER TABLE batch DROP COLUMN cleared_at');
    db.exec('ALTER TABLE ticket DROP COLUMN cleared_at');
  }
  const current = { config: f.cfg, configPath: f.cfg._config_path, port: 12348, token: 'd'.repeat(64) };
  expect(() => initialize(current)).toThrow('Web instance requires an initialized current database');
  using db = openDb(f.path);
  expect(db.prepare('SELECT cleared_at FROM batch').all().map((row) => ({ ...row }))).toEqual([{ cleared_at: null }]);
  expect(db.prepare('PRAGMA table_info(ticket)').all().some((column) => column.name === 'cleared_at')).toBe(true);
  initialize(current);
  release(current);
});

test('page clear hides a skipped batch, keeps its messages and refuses other batches', async () => {
  const fixture = webFixture();
  const current = { config: fixture.cfg, configPath: fixture.cfg._config_path, port: 12349, token: 'e'.repeat(64) };
  const post = (id: number, body: unknown) => actionPost(new Request(`http://127.0.0.1:12349/api/batch/${id}/clear`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { host: '127.0.0.1:12349', origin: 'http://127.0.0.1:12349', 'x-dispatcher-token': current.token, 'content-type': 'application/json' },
  }), 'batch', String(id), 'clear');
  const routed = (() => { using db = new DatabaseSync(fixture.path, { readOnly: true }); return Number(db.prepare('SELECT id FROM batch WHERE ticket IS NOT NULL ORDER BY id LIMIT 1').get()!.id); })();
  initialize(current);
  try {
    expect((await post(fixture.skipped, { extra: true })).status).toBe(400);
    const cleared = await post(fixture.skipped, {});
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ batch: fixture.skipped });
    expect((await post(fixture.skipped, {})).status).toBe(200);
    expect((await post(routed, {})).status).toBe(409);
    expect((await post(999_999, {})).status).toBe(404);
    using db = new DatabaseSync(fixture.path, { readOnly: true });
    expect(readState(db, fixture.cfg).skipped.map((batch) => batch.id)).toEqual(expect.not.arrayContaining([fixture.skipped]));
    expect(readState(db, fixture.cfg).skipped.map((batch) => batch.id)).toEqual(expect.arrayContaining([fixture.backlog, fixture.answered]));
    expect(db.prepare("SELECT outcome,cleared_at IS NOT NULL AS cleared FROM batch WHERE id=?").get(fixture.skipped)).toMatchObject({ outcome: 'not_on_us', cleared: 1 });
  } finally { release(current); }
});

test('page clear hides a dismissed or done ticket and refuses open tickets', async () => {
  const fixture = webFixture();
  const current = { config: fixture.cfg, configPath: fixture.cfg._config_path, port: 12350, token: 'f'.repeat(64) };
  const post = (id: number) => actionPost(new Request(`http://127.0.0.1:12350/api/ticket/${id}/clear`, {
    method: 'POST', body: '{}',
    headers: { host: '127.0.0.1:12350', origin: 'http://127.0.0.1:12350', 'x-dispatcher-token': current.token, 'content-type': 'application/json' },
  }), 'ticket', String(id), 'clear');
  initialize(current);
  try {
    const cleared = await post(fixture.dismissed);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ticket: fixture.dismissed });
    expect((await post(fixture.dismissed)).status).toBe(200);
    expect((await post(fixture.done)).status).toBe(200);
    expect((await post(fixture.proposal)).status).toBe(409);
    expect((await post(fixture.active)).status).toBe(409);
    expect((await post(999_999)).status).toBe(404);
    using db = new DatabaseSync(fixture.path, { readOnly: true });
    const state = readState(db, fixture.cfg);
    expect(state.groups.skipped.map((ticket) => ticket.id)).not.toContain(fixture.dismissed);
    expect(state.groups.done_today.map((ticket) => ticket.id)).not.toContain(fixture.done);
    expect(db.prepare('SELECT lifecycle FROM ticket WHERE id=?').get(fixture.dismissed)!.lifecycle).toBe('dismissed');
  } finally { release(current); }
});

test('a batch waiting for or in triage shows as triaging until its assessment lands', () => {
  const f = instance();
  using db = openDb(f.path);
  ingest(db, message('me@example.invalid', 'fresh-1'));
  expect(readState(db, f.cfg, new Date(later(1))).triaging).toEqual([]);
  schedule(db, f.cfg, later(10));
  const triaging = readState(db, f.cfg, new Date(later(11))).triaging;
  expect(triaging).toHaveLength(1);
  expect(triaging[0]).toMatchObject({ title: 'Chat me@example.invalid', source: 'teams', account: 'me@example.invalid', job: 'queued' });
  expect(triaging[0]!.messages.map((item) => item.text)).toEqual(['Synthetic fresh-1']);
  db.prepare("UPDATE job SET state='running' WHERE kind='triage'").run();
  expect(readState(db, f.cfg, new Date(later(12))).triaging[0]!.job).toBe('running');
  db.prepare("UPDATE batch SET state='done',outcome='not_on_us',done_at=?").run(later(13));
  expect(readState(db, f.cfg, new Date(later(14))).triaging).toEqual([]);
});

test('a chat muted at the source skips triage unless a message mentions the owner, and unmuting restores triage', () => {
  const f = instance();
  using db = openDb(f.path);
  const chat = 'chat-me@example.invalid';
  const outcome = () => String(db.prepare('SELECT outcome FROM batch ORDER BY id DESC').get()!.outcome);
  expect(ingest(db, { source: 'teams', account: 'Me@Example.invalid', muted: [chat, 'other-chat'] })).toBe(true);
  ingest(db, message('me@example.invalid', 'quiet-1'));
  schedule(db, f.cfg, later(10));
  expect(outcome()).toBe('muted');
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='triage'").get()!.n).toBe(0);
  expect(db.prepare('SELECT cleared_at FROM batch ORDER BY id DESC').get()!.cleared_at).not.toBeNull();
  expect(readState(db, f.cfg, new Date(later(11))).skipped).toEqual([]);
  ingest(db, message('me@example.invalid', 'tagged-1', { sent_at: later(20), ref: { mentions_me: true } }));
  expect(schedule(db, f.cfg, later(30))).toHaveLength(1);
  expect(outcome()).toBe('triage');
  ingest(db, { source: 'teams', account: 'me@example.invalid', muted: [] });
  ingest(db, message('me@example.invalid', 'after-unmute', { conversation_id: 'other-chat', sent_at: later(60) }));
  schedule(db, f.cfg, later(70));
  expect(outcome()).toBe('triage');
  expect(db.prepare("SELECT COUNT(*) AS n FROM batch WHERE outcome='muted'").get()!.n).toBe(1);
  expect(() => ingest(db, { source: 'teams', account: 'me@example.invalid', muted: [''] })).toThrow();
});

test('a muted chat that feeds a running ticket chat still forwards every follow-up to that chat', () => {
  const f = instance('[chats]\nenabled = true\n');
  using db = openDb(f.path);
  const chat = 'chat-me@example.invalid';
  ingest(db, { source: 'teams', account: 'me@example.invalid', muted: [chat] });
  ingest(db, message('me@example.invalid', 'first'));
  schedule(db, f.cfg, later(10));
  const conversation = Number(db.prepare('SELECT id FROM conversation').get()!.id);
  const ticket = Number(db.prepare(`INSERT INTO ticket(title,summary,ask,proposal,kb_notes,created_at,last_activity_at,lifecycle,approved_at,session_id)
    VALUES ('Running','s','a','p','[]',?,?,'active',?,'ses_running')`).run(AT, AT, AT).lastInsertRowid);
  db.prepare("INSERT INTO ticket_conversation(ticket,conversation,kind,\"by\",created_at) VALUES (?,?,'primary','agent',?)").run(ticket, conversation, AT);
  ingest(db, message('me@example.invalid', 'follow-up', { sent_at: later(20) }));
  expect(schedule(db, f.cfg, later(30))).toHaveLength(1);
  const batch = db.prepare('SELECT id,ticket,outcome,cleared_at FROM batch ORDER BY id DESC').get()!;
  expect({ ...batch }).toMatchObject({ ticket, outcome: 'forward', cleared_at: null });
  const job = db.prepare("SELECT ticket,payload FROM job WHERE kind='forward'").get()!;
  expect(job.ticket).toBe(ticket);
  expect(JSON.parse(String(job.payload)).batch_ids).toEqual([batch.id]);
  db.prepare("UPDATE ticket SET lifecycle='done',closed_at=? WHERE id=?").run(later(40), ticket);
  ingest(db, message('me@example.invalid', 'after-done', { sent_at: later(50) }));
  schedule(db, f.cfg, later(60));
  expect(db.prepare('SELECT outcome FROM batch ORDER BY id DESC').get()!.outcome).toBe('muted');
});

test('a muted chat stays out of triage until the mute ends, and own-only batches stay answered', () => {
  const f = instance();
  using db = openDb(f.path);
  ingest(db, message('me@example.invalid', 'm1'));
  const conversation = Number(db.prepare('SELECT id FROM conversation').get()!.id);
  mute(db, conversation, 24, AT);
  expect(schedule(db, f.cfg, later(10))).toEqual([]);
  expect(db.prepare('SELECT state,outcome FROM batch').get()).toMatchObject({ state: 'done', outcome: 'muted' });
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='triage'").get()!.n).toBe(0);
  const state = readState(db, f.cfg, new Date(later(20)));
  expect(state.skipped.map((batch) => batch.outcome)).toEqual(['muted']);
  expect(state.muted).toEqual([{ id: conversation, title: 'Chat me@example.invalid', source: 'teams', account: 'me@example.invalid',
    until: '2026-11-07T10:00:00.000000Z', forever: false }]);
  ingest(db, message('me@example.invalid', 'own', { sender: 'oid-me', sender_is_me: true, sent_at: later(30) }));
  schedule(db, f.cfg, later(40));
  expect(db.prepare('SELECT outcome FROM batch ORDER BY id DESC').get()!.outcome).toBe('answered');
  ingest(db, message('me@example.invalid', 'm2', { sent_at: later(25 * 60) }));
  expect(schedule(db, f.cfg, later(25 * 60 + 10))).toHaveLength(1);
  expect(db.prepare('SELECT outcome FROM batch ORDER BY id DESC').get()!.outcome).toBe('triage');
  expect(readState(db, f.cfg, new Date(later(25 * 60 + 10))).muted).toEqual([]);
});

test('mute until unmuted, Make ticket from a muted batch, dismiss with mute and unmute', () => {
  const f = instance();
  using db = openDb(f.path);
  ingest(db, message('me@example.invalid', 'm1'));
  const conversation = Number(db.prepare('SELECT id FROM conversation').get()!.id);
  mute(db, conversation, null, AT);
  expect(readState(db, f.cfg, new Date('2099-01-01T00:00:00Z')).muted[0]).toMatchObject({ id: conversation, until: MUTE_FOREVER, forever: true });
  schedule(db, f.cfg, later(10));
  const batch = Number(db.prepare("SELECT id FROM batch WHERE outcome='muted'").get()!.id);
  const ticket = makeTicket(db, batch, later(11));
  expect(db.prepare('SELECT muted_until FROM conversation WHERE id=?').get(conversation)!.muted_until).toBeNull();
  expect(db.prepare('SELECT lifecycle FROM ticket WHERE id=?').get(ticket)!.lifecycle).toBe('proposed');
  dismiss(db, ticket, 'Noise', later(12));
  expect(muteTicket(db, ticket, 168, later(12))).toEqual([conversation]);
  expect(db.prepare('SELECT muted_until FROM conversation WHERE id=?').get(conversation)!.muted_until).toBe('2026-11-13T10:12:00.000000Z');
  mute(db, conversation, 0, later(13));
  expect(readState(db, f.cfg, new Date(later(14))).muted).toEqual([]);
  for (const hours of [-1, 8_761, 1.5]) expect(() => mute(db, conversation, hours, AT)).toThrow(TicketError);
  expect(() => mute(db, 999_999, 1, AT)).toThrow('Conversation 999999 not found');
});

test('page actions mute a skipped chat, dismiss with mute and unmute, rejecting invalid hours', async () => {
  const fixture = webFixture();
  const current = { config: fixture.cfg, configPath: fixture.cfg._config_path, port: 12346, token: 'b'.repeat(64) };
  const post = (scope: 'ticket' | 'batch' | 'conversation', id: number, action: string, body: unknown) => actionPost(new Request(`http://127.0.0.1:12346/api/${scope}/${id}/${action}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { host: '127.0.0.1:12346', origin: 'http://127.0.0.1:12346', 'x-dispatcher-token': current.token, 'content-type': 'application/json' },
  }), scope, String(id), action);
  const mutedUntil = (conversation: number) => {
    using db = new DatabaseSync(fixture.path, { readOnly: true });
    return db.prepare('SELECT muted_until FROM conversation WHERE id=?').get(conversation)?.muted_until ?? null;
  };
  initialize(current);
  try {
    for (const body of [{ hours: 0 }, { hours: 8_761 }, { hours: 1.5 }, {}, { hours: 1, extra: true }]) expect((await post('batch', fixture.skipped, 'mute', body)).status).toBe(400);
    const muted = await post('batch', fixture.skipped, 'mute', { hours: null });
    expect(muted.status).toBe(200);
    const { conversation } = await muted.json() as { conversation: number };
    expect(mutedUntil(conversation)).toBe(MUTE_FOREVER);

    const before = Date.now();
    const dismissed = await post('ticket', fixture.proposal, 'dismiss', { reason: 'Noise', mute_hours: 24 });
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toEqual({ ticket: fixture.proposal });
    {
      using db = new DatabaseSync(fixture.path, { readOnly: true });
      const linked = db.prepare("SELECT c.muted_until FROM ticket_conversation t JOIN conversation c ON c.id=t.conversation WHERE t.ticket=?").all(fixture.proposal);
      expect(linked.length).toBeGreaterThan(0);
      for (const row of linked) expect(Date.parse(String(row.muted_until)) - before).toBeGreaterThanOrEqual(24 * 3_600_000 - 1_000);
      expect(db.prepare('SELECT lifecycle FROM ticket WHERE id=?').get(fixture.proposal)!.lifecycle).toBe('dismissed');
    }

    const unmuted = await post('conversation', conversation, 'unmute', {});
    expect(await unmuted.json()).toEqual({ conversation });
    expect(mutedUntil(conversation)).toBeNull();
    expect((await post('conversation', 999_999, 'unmute', {})).status).toBe(404);
  } finally { release(current); }
});
