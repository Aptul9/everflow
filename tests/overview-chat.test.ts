import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CliError, parseCommand } from '../src/cli.ts';
import { ClientChats, clientDirectory, overviewClients, saidYesterday } from '../src/core/client-chat.ts';
import { loadConfig } from '../src/core/config.ts';
import { openDb, prepareStart } from '../src/core/db.ts';
import { connect } from '../src/core/opencode.ts';
import { createTicket, dismiss, dismissFromChat, restorable, restoreTicket, ticketList } from '../src/core/tickets.ts';
import type { Ticket } from '../src/core/tickets.ts';
import { actionPost, clientChatPost } from '../src/web/api.ts';
import { initialize, release } from '../src/web/instance.ts';
import { scriptedPeer } from './opencode-support.ts';
import { scratch } from './support.ts';
import { webFixture } from './web-fixture.ts';

const AT = '2026-11-23T11:00:00.000000Z';
const BASE = ['--config', resolve('config.toml'), '--artifact', resolve('build-receipt.json')];

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT)); });
afterEach(() => vi.useRealTimers());

function fixture() {
  const files = scratch('overview-chat-');
  const cfg = loadConfig(files.config);
  cfg.tickets.enabled = true;
  cfg.chats.enabled = true;
  cfg.clients = { acme: { accounts: [], domains: ['acme.invalid'], keywords: [], role: 'Platform lead for the AKS move' }, other: { accounts: [], domains: [], keywords: [] } };
  cfg.initiatives = { 'acme-plan': { title: 'Cost plan', client: 'acme', note: '01_Projects/acme/plan.md', related: ['02_Areas/acme/people.md'] },
    'beta-move': { title: 'Move', client: 'beta', note: '01_Projects/beta.md' } };
  return { ...files, cfg };
}

const row = (db: ReturnType<typeof openDb>, id: number) => db.prepare('SELECT * FROM ticket WHERE id=?').get(id) as unknown as Ticket;

test('the Overview chat dismisses tickets of its client only, all or none, with a reason, through the page Dismiss path', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const a = createTicket(db, cfg, { client: 'acme', title: 'Cut one node', initiative: 'acme-plan', origin: 'ai' });
  const b = createTicket(db, cfg, { client: 'acme', title: 'Board work' });
  const foreign = createTicket(db, cfg, { client: 'other', title: 'Not theirs' });
  expect(() => dismissFromChat(db, 'acme', [a, foreign], 'Done elsewhere')).toThrow(`Ticket ${foreign} is not a ticket of acme`);
  expect(() => dismissFromChat(db, 'acme', [a], '  ')).toThrow(/reason/);
  expect(db.prepare("SELECT COUNT(*) AS n FROM ticket WHERE lifecycle='dismissed'").get()!.n).toBe(0);
  expect(dismissFromChat(db, 'acme', [a, b, a], 'Already done by Roberto')).toEqual([{ ticket: a, lifecycle: 'dismissed' }, { ticket: b, lifecycle: 'dismissed' }]);
  expect(db.prepare("SELECT kind,actor,body,event_key FROM timeline WHERE ticket=? AND kind='status'").all(a)).toEqual([
    { kind: 'status', actor: 'overview chat', body: 'Already done by Roberto', event_key: `dismiss:ticket:${a}` }]);
  expect(row(db, a)).toMatchObject({ lifecycle: 'dismissed', dismissed_by: 'overview_chat', report_line: 'Already done by Roberto' });
  // already dismissed: left as it is
  expect(dismissFromChat(db, 'acme', [a], 'Again')).toEqual([{ ticket: a, lifecycle: 'dismissed' }]);
  const page = createTicket(db, cfg, { client: 'acme', title: 'Page dismissed' });
  dismiss(db, page, 'No');
  expect(row(db, page).dismissed_by).toBeNull();
  expect(restorable(row(db, page))).toBe(false);
});

test('Ripristina puts back a proposal the chat dismissed that never had a chat; nothing else', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const proposal = createTicket(db, cfg, { client: 'acme', title: 'Ask Bob', initiative: 'acme-plan', origin: 'ai' });
  const wait = createTicket(db, cfg, { client: 'acme', title: 'Waiting on Bob', waiting: { who: 'Bob', what: 'APIs', since: '2026-11-18' } });
  dismissFromChat(db, 'acme', [proposal, wait], 'Not needed');
  expect(restorable(row(db, proposal))).toBe(true);
  expect(restorable(row(db, wait))).toBe(false);
  expect(() => restoreTicket(db, wait)).toThrow(/Only a proposal/);
  expect(restoreTicket(db, proposal)).toBe(proposal);
  expect(row(db, proposal)).toMatchObject({ lifecycle: 'proposed', closed_at: null, report: null, report_line: null, dismissed_by: null });
  expect(db.prepare("SELECT actor,body FROM timeline WHERE ticket=? AND event_key LIKE 'restore:%'").all(proposal)).toEqual([{ actor: 'you', body: 'Restored: dismissed by the Overview chat' }]);
  expect(() => restoreTicket(db, proposal)).toThrow(/Only a proposal/);
});

test('ticket list gives the chat each ticket of the client with its column, origin, why and wait; finished ones for 7 days', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const why = { text: 'Node pool idles at night', sources: [{ id: 'L2', kind: 'log' as const, date: '2026-11-20', text: 'Usage report' }] };
  const ai = createTicket(db, cfg, { client: 'acme', title: 'Cut one node', initiative: 'acme-plan', origin: 'ai', why });
  const mine = createTicket(db, cfg, { client: 'acme', title: 'Plan step', initiative: 'acme-plan' });
  const wait = createTicket(db, cfg, { client: 'acme', title: 'Waiting on Bob', initiative: 'acme-plan', waiting: { who: 'Bob', what: 'APIs', since: '2026-11-18' } });
  const board = createTicket(db, cfg, { client: 'acme', title: 'Board work' });
  const old = createTicket(db, cfg, { client: 'acme', title: 'Old' });
  db.prepare("UPDATE ticket SET lifecycle='done',closed_at='2026-11-01T09:00:00Z',last_activity_at='2026-11-01T09:00:00Z' WHERE id=?").run(old);
  createTicket(db, cfg, { client: 'other', title: 'Not theirs' });
  const list = ticketList(db, cfg, 'acme');
  expect(list.map((item) => [item.id, item.column, item.origin, item.initiative])).toEqual([[ai, 'AI', 'ai', 'acme-plan'], [mine, 'You', 'hand', 'acme-plan'],
    [wait, 'Them', 'hand', 'acme-plan'], [board, 'Needs you', 'hand', null]]);
  expect(list[0]).toMatchObject({ why: 'Node pool idles at night', why_sources: ['L2'], has_chat: false });
  expect(list[2]!.waiting_on).toBe('Bob: APIs');
  expect(ticketList(db, cfg, 'acme', 'acme-plan').map((item) => item.id)).toEqual([ai, mine, wait]);
  expect(() => ticketList(db, cfg, 'other', 'acme-plan')).toThrow(/Unknown initiative/);
});

test('ticket list and ticket dismiss parse their client, initiative and reason, and refuse the rest', () => {
  expect(parseCommand([...BASE, 'ticket', 'list', '--client', 'acme'], undefined)).toMatchObject({ name: 'ticket list', args: [], scope: { client: 'acme' } });
  expect(parseCommand([...BASE, 'ticket', 'list', '--client', 'acme', '--initiative', 'acme-plan'], undefined).scope).toEqual({ client: 'acme', initiative: 'acme-plan' });
  expect(parseCommand([...BASE, 'ticket', 'dismiss', '12', '15', '--client', 'acme', '--reason', 'Done by Bob'], undefined))
    .toMatchObject({ name: 'ticket dismiss', args: [12, 15], reason: 'Done by Bob', scope: { client: 'acme' } });
  for (const args of [['ticket', 'list'], ['ticket', 'list', '7', '--client', 'acme'], ['ticket', 'list', '--client', 'acme', '--title', 'x'],
    ['ticket', 'dismiss', '--client', 'acme', '--reason', 'x'], ['ticket', 'dismiss', '12', '--client', 'acme'], ['ticket', 'dismiss', '12', '--client', 'acme', '--reason', ' '],
    ['ticket', 'dismiss', '12', '--reason', 'x'], ['ticket', 'dismiss', '12', '--client', 'acme', '--reason', 'x', '--initiative', 'acme-plan'],
    ['ticket', 'close', '7', '--client', 'acme']]) {
    expect(() => parseCommand([...BASE, ...args], undefined), args.join(' ')).toThrow(CliError);
  }
});

test('the client chat folder is the client directory, else one named after the client; only Overview clients count', () => {
  const { cfg } = fixture();
  expect(overviewClients(cfg)).toEqual(['acme', 'beta']);
  expect(clientDirectory(cfg, 'beta')).toBe(join(cfg.opencode.directory, 'beta'));
  cfg.clients.acme!.directory = '/srv/acme';
  expect(clientDirectory(cfg, 'acme')).toBe('/srv/acme');
});

test('yesterday\'s words keep the newest messages within the cap, in order', () => {
  expect(saidYesterday(['first', 'second\nline', '  ', 'third'], 25)).toBe('- second\n  line\n- third');
  expect(saidYesterday(['x'.repeat(50)], 20)).toBe(`- ${'x'.repeat(17)}`);
  expect(saidYesterday([])).toBe('');
});

test('one chat per client and day: created at the first open in the client folder with the chat model and a brief that runs no turn; the next day carries Antonio\'s words and archives the old one', async () => {
  const { path, cfg } = fixture();
  { using db = openDb(path); prepareStart(db); }
  await using peer = await scriptedPeer();
  cfg.opencode.url = peer.url;
  cfg.opencode.model = 'meridian-auto/claude-opus-5-5';
  const registered: string[] = [];
  let now = new Date(AT);
  const chats = new ClientChats(cfg, { open: async (session) => { registered.push(session); return `/canonical/${session}`; },
    peer: () => connect(cfg), buildReceipt: process.env.TEST_BUILD_RECEIPT, now: () => now });
  await expect(chats.open('nobody')).rejects.toMatchObject({ status: 404, code: 'chat.client' });
  const [first, again] = await Promise.all([chats.open('acme'), chats.open('acme')]);
  expect(first).toEqual({ client: 'acme', day: '2026-11-23', session_id: 'ses_1', directory: '/canonical/ses_1' });
  expect(again).toEqual(first);
  expect(peer.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session')).toHaveLength(1);
  const session = peer.sessions.get('ses_1')!;
  expect(session.location.directory).toBe(join(cfg.opencode.directory, 'acme'));
  expect(existsSync(join(cfg.opencode.directory, 'acme'))).toBe(true);
  expect(session.metadata).toMatchObject({ everflow: { overview_client: 'acme', day: '2026-11-23' } });
  expect(session.model).toMatchObject({ providerID: 'meridian-auto', id: 'claude-opus-5-5' });
  const synthetic = peer.calls.find((call) => call.url.pathname === '/api/session/ses_1/synthetic')!;
  expect(synthetic.body).toMatchObject({ resume: false, description: 'Everflow brief' });
  const brief = String(synthetic.body.text);
  expect(brief).toContain('Who Antonio is at acme: Platform lead for the AKS move');
  expect(brief).toContain(`- acme-plan: Cost plan. Note: ${join(cfg.vault.path, '01_Projects/acme/plan.md')}. Related: ${join(cfg.vault.path, '02_Areas/acme/people.md')}`);
  expect(brief).toContain('ticket list --client acme');
  expect(brief).toContain("ticket dismiss ID [ID...] --client acme --reason 'TEXT'");
  expect(brief).toContain('only after his explicit yes in this chat');
  expect(brief).toContain('Detto ieri: nothing.');
  expect(brief).not.toMatch(/beta-move/);
  // no turn: nothing ran in the session
  expect(peer.messages.get('ses_1')!.map((message) => message.type)).toEqual(['synthetic']);
  expect((await chats.status('acme'))).toEqual({ client: 'acme', day: '2026-11-23', session_id: 'ses_1', running: false });
  expect(await chats.open('acme')).toEqual(first);
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/synthetic'))).toHaveLength(1);
  expect(registered).toEqual(['ses_1', 'ses_1']);

  // Antonio wrote in it; the next day is a new chat with his words and the old one archived
  peer.messages.get('ses_1')!.push({ id: 'msg_u1', type: 'user', text: 'Skip anything about reservations', time: { created: Date.now() } });
  now = new Date('2026-11-24T08:00:00Z');
  expect((await chats.status('acme')).session_id).toBeNull();
  const next = await chats.open('acme');
  expect(next.session_id).toBe('ses_2');
  expect(peer.sessions.get('ses_1')!.time.archived).toBeDefined();
  const second = String(peer.calls.find((call) => call.url.pathname === '/api/session/ses_2/synthetic')!.body.text);
  expect(second).toContain("Detto ieri (Antonio's own messages in the acme chat of 23/11, text only: his preferences carry over):\n- Skip anything about reservations");
  expect(second).not.toContain('Everflow brief for the acme chat of 23/11');
  { using db = openDb(path); expect(JSON.parse(String(db.prepare("SELECT value FROM setting WHERE key='overview.chat:acme'").get()!.value))).toMatchObject({ day: '2026-11-24', session_id: 'ses_2', previous: 'ses_1', previous_archived: true, briefed: true }); }
  peer.sessions.get('ses_2')!.time.busy = Date.now() + 1;
  expect((await chats.status('acme')).running).toBe(true);
});

test('the page reaches the client chat through guarded POSTs; Ripristina goes through the ticket action route', async () => {
  const fixture = webFixture();
  const opened: string[] = [];
  const current = { config: fixture.cfg, configPath: fixture.cfg._config_path, port: 12361, token: 'b'.repeat(64), clientChat: {
    open: async (client: string) => {
      opened.push(client);
      if (client === 'gone') throw Object.assign(new Error('OpenChamber could not open the gone chat'), { status: 502, code: 'chat.unavailable' });
      return { client, day: '2026-11-23', session_id: 'ses_1', directory: '/home/aptul/everflow-chats/acme' };
    },
    status: async (client: string) => ({ client, day: '2026-11-23', session_id: null, running: false }) } };
  const post = (client: string, action: string, token = current.token, body = '{}') => clientChatPost(new Request(`http://127.0.0.1:12361/api/client-chat/${client}/${action}`, {
    method: 'POST', body, headers: { host: '127.0.0.1:12361', origin: 'http://127.0.0.1:12361', 'x-everflow-token': token, 'content-type': 'application/json' } }), client, action);
  { using db = openDb(fixture.path); db.prepare("UPDATE ticket SET client='acme' WHERE id=?").run(fixture.proposal); dismissFromChat(db, 'acme', [fixture.proposal], 'Not needed'); }
  initialize(current);
  try {
    const open = await post('acme', 'open');
    expect([open.status, await open.json()]).toEqual([200, { client: 'acme', day: '2026-11-23', session_id: 'ses_1', directory: '/home/aptul/everflow-chats/acme' }]);
    expect(await (await post('acme', 'status')).json()).toEqual({ client: 'acme', day: '2026-11-23', session_id: null, running: false });
    const failed = await post('gone', 'open');
    expect([failed.status, (await failed.json()).error.code]).toEqual([502, 'chat.unavailable']);
    expect((await post('acme', 'open', 'f'.repeat(64))).status).toBe(403);
    expect((await post('acme', 'open', current.token, '{"extra":1}')).status).toBe(400);
    expect((await post('acme', 'delete')).status).toBe(404);
    expect(opened).toEqual(['acme', 'gone']);
    const restore = (id: number) => actionPost(new Request(`http://127.0.0.1:12361/api/ticket/${id}/restore`, { method: 'POST', body: '{}',
      headers: { host: '127.0.0.1:12361', origin: 'http://127.0.0.1:12361', 'x-everflow-token': current.token, 'content-type': 'application/json' } }), 'ticket', String(id), 'restore');
    expect([(await restore(fixture.proposal)).status, (await restore(fixture.proposal)).status, (await restore(fixture.dismissed)).status]).toEqual([200, 409, 409]);
    using db = openDb(fixture.path);
    expect(row(db, fixture.proposal).lifecycle).toBe('proposed');
  } finally { release(current); }
  // without chat_origin there is no client chat to reach
  const plain = { config: fixture.cfg, configPath: fixture.cfg._config_path, port: 12361, token: 'b'.repeat(64) };
  initialize(plain);
  try { expect([(await post('acme', 'open')).status]).toEqual([404]); } finally { release(plain); }
});

test('an OpenChamber failure says so as a chat error, and a brief not yet admitted is sent at the next open', async () => {
  const { path, cfg } = fixture();
  { using db = openDb(path); prepareStart(db); }
  await using peer = await scriptedPeer();
  cfg.opencode.url = peer.url;
  let fail = true;
  peer.state.hook = (call, response) => {
    if (!fail || !call.url.pathname.endsWith('/synthetic')) return false;
    peer.json(response, { message: 'down' }, 503);
    return true;
  };
  const chats = new ClientChats(cfg, { open: async () => '/folder', peer: () => connect(cfg), buildReceipt: process.env.TEST_BUILD_RECEIPT });
  await expect(chats.open('acme')).rejects.toMatchObject({ status: 502, code: 'chat.unavailable' });
  fail = false;
  expect((await chats.open('acme')).session_id).toBe('ses_1');
  expect(peer.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session')).toHaveLength(1);
  expect(peer.messages.get('ses_1')!.map((message) => message.type)).toEqual(['synthetic']);
});
