import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CliError, parseCommand } from '../src/cli.ts';
import { approve } from '../src/core/approval.ts';
import { loadConfig } from '../src/core/config.ts';
import { openDb } from '../src/core/db.ts';
import { readInitiatives } from '../src/core/initiative-state.ts';
import { becomeWait, createTicket, stage, waitAnswered } from '../src/core/tickets.ts';
import { scratch } from './support.ts';

const AT = '2026-11-21T09:00:00.000000Z';
const BASE = ['--config', resolve('config.toml'), '--artifact', resolve('build-receipt.json')];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AT));
});
afterEach(() => vi.useRealTimers());

function fixture() {
  const files = scratch('ticket-create-');
  const cfg = loadConfig(files.config);
  cfg.tickets.enabled = true;
  cfg.chats.enabled = true;
  cfg.clients = { acme: { accounts: [], domains: ['acme.invalid'], keywords: [] } };
  return { ...files, cfg };
}

test('a hand-made ticket is proposed, has no conversation and keeps its fields and KB notes', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const id = createTicket(db, cfg, { client: 'acme', title: '  Cut one node  ', summary: 'Saves 350 USD a month', ask: 'Remove one node',
    proposal: '1. Drain\n2. Scale', kb_notes: ['01_Projects/acme/plan.md'] });
  expect(db.prepare('SELECT title,client,summary,ask,proposal,kb_notes,lifecycle,approved_at,session_id,created_at FROM ticket WHERE id=?').get(id)).toEqual({
    title: 'Cut one node', client: 'acme', summary: 'Saves 350 USD a month', ask: 'Remove one node', proposal: '1. Drain\n2. Scale',
    kb_notes: '["01_Projects/acme/plan.md"]', lifecycle: 'proposed', approved_at: null, session_id: null, created_at: AT });
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_conversation WHERE ticket=?').get(id)!.n).toBe(0);
  expect(db.prepare('SELECT kind,actor,body,event_key FROM timeline WHERE ticket=?').all(id)).toEqual([
    { kind: 'comment', actor: 'you', body: 'Created by hand', event_key: `create:ticket:${id}` }]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()!.n).toBe(0);
  expect(stage(db, id)).toBe('Needs you');
});

test('the same key returns the ticket made the first time', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const first = createTicket(db, cfg, { client: 'acme', title: 'Return reservation', key: 'acme-cost-1.1' });
  expect(createTicket(db, cfg, { client: 'acme', title: 'Return reservation again', key: 'acme-cost-1.1' })).toBe(first);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()!.n).toBe(1);
  expect(createTicket(db, cfg, { client: 'acme', title: 'Other', key: 'acme-cost-1.2' })).not.toBe(first);
});

test('unknown client, empty title, unsafe note path, bad key and extra fields are refused before any write', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  expect(() => createTicket(db, cfg, { client: 'nobody', title: 'X' })).toThrow(/Unknown configured client/);
  expect(() => createTicket(db, cfg, { client: 'acme', title: '   ' })).toThrow();
  expect(() => createTicket(db, cfg, { client: 'acme', title: 'X', kb_notes: ['../secrets.md'] })).toThrow(/Unsafe/);
  expect(() => createTicket(db, cfg, { client: 'acme', title: 'X', kb_notes: ['notes.txt'] })).toThrow(/Unsafe/);
  expect(() => createTicket(db, cfg, { client: 'acme', title: 'X', key: 'has space' })).toThrow(/Key/);
  expect(() => createTicket(db, cfg, { client: 'acme', title: 'X', lifecycle: 'active' })).toThrow();
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()!.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM timeline').get()!.n).toBe(0);
});

test('approving a hand-made ticket opens its chat like any proposed ticket', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const id = createTicket(db, cfg, { client: 'acme', title: 'Buy reservation' });
  expect(approve(cfg, db, id, 'Go ahead')).toBe(id);
  expect(db.prepare('SELECT lifecycle,approval_note FROM ticket WHERE id=?').get(id)).toEqual({ lifecycle: 'active', approval_note: 'Go ahead' });
  expect(db.prepare("SELECT kind,ticket FROM job WHERE kind='start_chat'").all()).toEqual([{ kind: 'start_chat', ticket: id }]);
});

test('ticket create parses its fields, repeats --kb-note and refuses them on other commands', () => {
  const parsed = parseCommand([...BASE, 'ticket', 'create', '--client', 'acme', '--title', 'Cut one node', '--summary', 'S', '--ask', 'A',
    '--proposal', 'P', '--kb-note', '01_Projects/a.md', '--kb-note', '02_Areas/b.md', '--key', 'acme-1'], undefined);
  expect(parsed).toMatchObject({ name: 'ticket create', args: [], ticket: { client: 'acme', title: 'Cut one node', summary: 'S', ask: 'A', proposal: 'P',
    kb_notes: ['01_Projects/a.md', '02_Areas/b.md'], key: 'acme-1' } });
  expect(parseCommand([...BASE, 'ticket', 'create', '--client', 'acme', '--title', 'T'], undefined).ticket).toEqual({ client: 'acme', title: 'T' });
  expect(() => parseCommand([...BASE, 'ticket', 'create', '--title', 'T'], undefined)).toThrow(CliError);
  expect(() => parseCommand([...BASE, 'ticket', 'create', '--client', 'acme'], undefined)).toThrow(CliError);
  expect(() => parseCommand([...BASE, 'ticket', 'create', '--client', 'acme', '--title', 'T', '--title', 'U'], undefined)).toThrow(CliError);
  expect(() => parseCommand([...BASE, 'ticket', 'create', '7', '--client', 'acme', '--title', 'T'], undefined)).toThrow(CliError);
  expect(() => parseCommand([...BASE, 'ticket', 'close', '7', '--title', 'T'], undefined)).toThrow(CliError);
  expect(() => parseCommand([...BASE, 'status', '--kb-note', 'a.md'], undefined)).toThrow(CliError);
});

test('a ticket of an initiative is created only for that initiative client and shows on the Overview, not on the board', async () => {
  const { path, cfg } = fixture();
  cfg.initiatives = { 'acme-plan': { title: 'Plan', client: 'acme', note: '01_Projects/acme/plan.md', related: [] } };
  using db = openDb(path);
  expect(() => createTicket(db, cfg, { client: 'acme', title: 'X', initiative: 'missing' })).toThrow(/Unknown initiative/);
  cfg.clients.other = { accounts: [], domains: ['other.invalid'], keywords: [] };
  expect(() => createTicket(db, cfg, { client: 'other', title: 'X', initiative: 'acme-plan' })).toThrow(/Unknown initiative/);
  const planned = createTicket(db, cfg, { client: 'acme', title: 'Cut one node', initiative: 'acme-plan' });
  const loose = createTicket(db, cfg, { client: 'acme', title: 'Board work' });
  expect(db.prepare('SELECT initiative FROM ticket WHERE id=?').get(planned)!.initiative).toBe('acme-plan');
  const { readState } = await import('../src/web/state.ts');
  const view = readState(db, cfg, new Date(AT));
  expect(Object.values(view.groups).flat().map((ticket) => ticket.id)).toEqual([loose]);
  expect(view.initiatives['acme-plan']!.needs_you.map((ticket) => ticket.id)).toEqual([planned]);
  // A ticket in Them is a wait of the initiative: who from its STATUS line, Them without one
  const unnamed = createTicket(db, cfg, { client: 'acme', title: 'Licence check', initiative: 'acme-plan' });
  const report = db.prepare("UPDATE ticket SET lifecycle='active',approved_at=?,report='waiting_them',report_line=?,report_at='2026-11-18T09:00:00.000000Z' WHERE id=?");
  report.run(AT, 'Bob: answer on the AU APIs', planned);
  report.run(AT, 'Reply pending', unnamed);
  const later = Date.parse('2026-11-23T09:00:00Z');
  expect(readState(db, cfg, new Date(later)).initiatives['acme-plan']!.waiting_them.map((ticket) => ticket.id).sort((a, b) => a - b)).toEqual([planned, unnamed]);
  expect(readInitiatives(db, cfg, later).initiatives[0]!.waits).toEqual([
    { who: 'Bob', owes: 'them', text: 'answer on the AU APIs', since: '2026-11-18', days: 3, sources: [{ id: `T${planned}`, date: '2026-11-18', text: `Ticket #${planned}: Cut one node` }] },
    { who: 'Them', owes: 'them', text: 'Reply pending', since: '2026-11-18', days: 3, sources: [{ id: `T${unnamed}`, date: '2026-11-18', text: `Ticket #${unnamed}: Licence check` }] }]);
  expect(parseCommand([...BASE, 'ticket', 'create', '--client', 'acme', '--title', 'T', '--initiative', 'acme-plan'], undefined).ticket).toEqual({ client: 'acme', title: 'T', initiative: 'acme-plan' });
  // --ai: a ticket the AI suggested, in the AI column of its initiative while proposed
  expect(parseCommand([...BASE, 'ticket', 'create', '--client', 'acme', '--title', 'T', '--initiative', 'acme-plan', '--ai'], undefined).ticket).toEqual({ client: 'acme', title: 'T', initiative: 'acme-plan', origin: 'ai' });
  const suggested = createTicket(db, cfg, { client: 'acme', title: 'Remind Bob', initiative: 'acme-plan', origin: 'ai' });
  expect(readState(db, cfg, new Date(AT)).initiatives['acme-plan']!.needs_you.find((ticket) => ticket.id === suggested)?.origin).toBe('ai');
  expect(() => parseCommand([...BASE, 'ticket', 'close', '7', '--ai'], undefined)).toThrow(CliError);
});

test('a wait starts in Waiting on them with no chat, and the Overview map reads who and since from it', async () => {
  const { path, cfg } = fixture();
  cfg.initiatives = { 'acme-plan': { title: 'Plan', client: 'acme', note: '01_Projects/acme/plan.md', related: [] } };
  using db = openDb(path);
  const waiting = { who: 'Bob', what: 'answer on the AU APIs', since: '2026-11-18' };
  const id = createTicket(db, cfg, { client: 'acme', initiative: 'acme-plan', title: 'Waiting on Bob: answer on the AU APIs', waiting, key: 'acme-plan-wait-1', origin: 'ai' });
  expect(db.prepare('SELECT lifecycle,approval_note,report,report_line,report_at,session_id FROM ticket WHERE id=?').get(id)).toEqual({ lifecycle: 'active', approval_note: '',
    report: 'waiting_them', report_line: 'Bob: answer on the AU APIs', report_at: '2026-11-18T12:00:00.000000Z', session_id: null });
  expect(approve(cfg, db, id)).toBe(id);
  expect(stage(db, id)).toBe('Waiting on them');
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()!.n).toBe(0);
  expect(createTicket(db, cfg, { client: 'acme', initiative: 'acme-plan', title: 'Again', waiting, key: 'acme-plan-wait-1' })).toBe(id);
  expect(readInitiatives(db, cfg, Date.parse('2026-11-23T09:00:00Z')).initiatives[0]!.waits.map((wait) => [wait.who, wait.since, wait.days])).toEqual([['Bob', '2026-11-18', 3]]);
  const { readState } = await import('../src/web/state.ts');
  expect(readState(db, cfg, new Date(AT)).initiatives['acme-plan']!.waiting_them.map((ticket) => ticket.id)).toEqual([id]);
  expect(() => createTicket(db, cfg, { client: 'acme', title: 'X', waiting: { ...waiting, who: 'Bob: Smith' } })).toThrow(/colon/);
});

test('a proposed ask becomes its wait once, renamed and keeping its texts; a second ask of it leaves AI as dismissed, other work waits on the same answer', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const id = createTicket(db, cfg, { client: 'acme', title: 'Ask Bob: AU APIs', summary: 'Sent 18/11', ask: 'Get the answer', proposal: '1. Remind Bob', origin: 'ai' });
  const wait = { waiting: { who: 'Bob', what: 'AU APIs', since: '2026-11-18' }, title: 'Waiting on Bob: AU APIs', question: true };
  expect(becomeWait(db, id, wait, 'acme-wait-1')).toBe(id);
  expect(db.prepare('SELECT title,summary,ask,proposal,lifecycle,report,report_line FROM ticket WHERE id=?').get(id)).toEqual({ title: 'Waiting on Bob: AU APIs',
    summary: 'Sent 18/11', ask: 'Get the answer', proposal: '1. Remind Bob', lifecycle: 'active', report: 'waiting_them', report_line: 'Bob: AU APIs' });
  expect(becomeWait(db, id, wait, 'acme-wait-1')).toBeNull();
  expect(createTicket(db, cfg, { client: 'acme', title: 'Other', key: 'acme-wait-1' })).toBe(id);
  const twin = createTicket(db, cfg, { client: 'acme', title: 'Ask Bob again: AU APIs', origin: 'ai' });
  expect(becomeWait(db, twin, wait, 'acme-wait-1')).toBe(id);
  expect(db.prepare('SELECT lifecycle,report_line FROM ticket WHERE id=?').get(twin)).toEqual({ lifecycle: 'dismissed', report_line: `Already asked: same as wait #${id}` });
  expect(db.prepare("SELECT actor FROM timeline WHERE ticket=? AND kind='status'").get(twin)!.actor).toBe('agent');
  const work = createTicket(db, cfg, { client: 'acme', title: 'Decommission AU (760 USD/m)', proposal: '1. Export\n2. Delete' });
  expect(becomeWait(db, work, { ...wait, question: false }, 'acme-wait-1')).toBe(work);
  expect(db.prepare('SELECT title,proposal,report,report_line FROM ticket WHERE id=?').get(work)).toEqual({ title: 'Decommission AU (760 USD/m)', proposal: '1. Export\n2. Delete',
    report: 'waiting_them', report_line: 'Bob: AU APIs' });
  // Once the wait is answered, later work no longer joins it
  db.prepare("UPDATE ticket SET report='needs_you' WHERE id IN (?,?)").run(id, work);
  const late = createTicket(db, cfg, { client: 'acme', title: 'Delete US SFTP' });
  expect(becomeWait(db, late, { ...wait, question: false }, 'acme-wait-1')).toBeNull();
  expect(db.prepare('SELECT lifecycle FROM ticket WHERE id=?').get(late)!.lifecycle).toBe('proposed');
});

test('an answer found outside the chat moves a wait to Needs you once; a wait with a chat is left to its chat', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const waiting = { who: 'Bob', what: 'AU APIs', since: '2026-11-18' };
  const id = createTicket(db, cfg, { client: 'acme', title: 'Waiting on Bob', waiting });
  expect(waitAnswered(db, id, 'Answered 20/11: Bob says the AU APIs can go', 'ticket:1:a')).toBe(true);
  expect(db.prepare('SELECT report,report_line FROM ticket WHERE id=?').get(id)).toEqual({ report: 'needs_you', report_line: 'Answered 20/11: Bob says the AU APIs can go' });
  expect(stage(db, id)).toBe('Needs you');
  expect(waitAnswered(db, id, 'again', 'ticket:1:b')).toBe(false);
  const chatted = createTicket(db, cfg, { client: 'acme', title: 'Chat wait', waiting });
  db.prepare("UPDATE ticket SET session_id='ses_x' WHERE id=?").run(chatted);
  expect(waitAnswered(db, chatted, 'Answered', 'ticket:2:a')).toBe(false);
});

test('Discuss on a wait opens its first chat with the question as the note; later it changes nothing', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const id = createTicket(db, cfg, { client: 'acme', title: 'Waiting on Bob', waiting: { who: 'Bob', what: 'AU APIs', since: '2026-11-18' } });
  approve(cfg, db, id, 'Draft a reminder to Bob', true);
  expect(db.prepare('SELECT kind,state,payload FROM job WHERE ticket=?').all(id)).toEqual([{ kind: 'start_chat', state: 'queued', payload: '{"discuss":true}' }]);
  expect(db.prepare('SELECT approval_note FROM ticket WHERE id=?').get(id)!.approval_note).toBe('Draft a reminder to Bob');
  expect(stage(db, id)).toBe('Working');
  expect(approve(cfg, db, id, 'Draft a reminder to Bob', true)).toBe(id);
  expect(db.prepare('SELECT COUNT(*) AS n FROM job WHERE ticket=?').get(id)!.n).toBe(1);
});
