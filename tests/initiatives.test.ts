import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openDb } from '../src/core/db.ts';
import { localTime, markSeen, noteContext, parseSummary, proposeTickets, readInitiatives, refreshDue, refreshInitiatives, requestRefresh, workingDays } from '../src/core/initiatives.ts';
import type { InitiativeSource } from '../src/lib/web-types.ts';
import { kbFixture, provider, scriptedPeer } from './kb-support.ts';

// Wednesday 2026-11-18 10:00 in Rome
const AT = '2026-11-18T09:00:00Z';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT)); });
afterEach(() => { vi.useRealTimers(); });

const NOTE = `---
tags: [project/demo]
---

# Demo

## Status
Long status that is not read.

## Goal
RBAC design accepted by IAM.

## Log
- 2026-11-18 09:50 - SENT Liubomir: thanks, point taken.
- 2026-11-11 16:53 (Teams clock) - SENT Mohamed 4): standard section 1 still maps GEN 15.4, staying or removed?
- 2026-11-17 12:04 - SENT Geoff: Vault Qs 1-3.
- 2026-10-01 12:00 - Old entry outside the window.
- not a dated entry

## Blockers
- [ ] 2026-10-08 - Original gap assessment not on this machine.
- [x] 2026-09-01 - Done blocker.
`;

function fixture() {
  const kb = kbFixture();
  const { cfg } = kb;
  mkdirSync(join(cfg.vault.path, '01_Projects'), { recursive: true });
  writeFileSync(join(cfg.vault.path, '01_Projects/demo.md'), NOTE);
  cfg.initiatives = { demo: { title: 'OCP IAM', client: 'acme', note: '01_Projects/demo.md' } };
  cfg.overview.propose_tickets = false;
  return kb;
}

const offered = (...ids: string[]) => new Map<string, InitiativeSource>(ids.map((id, index) => [id, { id, date: `2026-11-1${index + 1}`, text: `entry ${id}` }]));

test('the note gives its goal, open blockers and the dated log entries of the window, newest first', () => {
  const context = noteContext(NOTE, '2026-11-18', 21);
  expect(context.goal).toBe('RBAC design accepted by IAM.');
  expect(context.blockers).toEqual(['2026-10-08 - Original gap assessment not on this machine.']);
  expect(context.entries.map((entry) => [entry.id, entry.date, entry.time])).toEqual([
    ['L1', '2026-11-18', '09:50'], ['L2', '2026-11-17', '12:04'], ['L3', '2026-11-11', '16:53 (Teams clock)']]);
  expect(context.entries[2]!.text).toContain('SENT Mohamed 4)');
});

test('working days skip weekends and Rome local time decides the day', () => {
  expect(workingDays('2026-11-11', '2026-11-18')).toBe(5);
  expect(workingDays('2026-11-13', '2026-11-16')).toBe(1);
  expect(workingDays('2026-11-18', '2026-11-18')).toBe(0);
  expect(localTime(Date.parse('2026-11-18T23:30:00Z'), 'Europe/Rome')).toEqual({ day: '2026-11-19', hour: 0, weekend: false });
  expect(localTime(Date.parse('2026-11-21T10:00:00Z'), 'Europe/Rome').weekend).toBe(true);
});

test('lines citing no offered entry are dropped and counted; their sources come oldest first', () => {
  const summary = parseSummary(JSON.stringify({
    state: 'waiting_them', headline: 'Mohamed holds four questions',
    now: [{ text: 'Real line', src: ['L2', 'L1'] }, { text: 'Invented line', src: ['L99'] }, { text: 'No source', src: [] }],
  }), offered('L1', 'L2', 'T7'), 'first/model', 3);
  expect(summary).toMatchObject({ state: 'waiting_them', headline: 'Mohamed holds four questions', rejected: 2, entries: 3, model: 'first/model' });
  expect(summary.now.map((line) => [line.text, line.sources.map((source) => source.id)])).toEqual([['Real line', ['L1', 'L2']]]);
});

test('a summary with no sourced now line, or not JSON, is refused', () => {
  expect(() => parseSummary('not json', offered('L1'), 'm', 1)).toThrow(/not JSON/);
  expect(() => parseSummary(JSON.stringify({ state: 'moving', headline: 'x', now: [{ text: 'a', src: ['L5'] }] }), offered('L1'), 'm', 1)).toThrow(/No line of now/);
  expect(() => parseSummary(JSON.stringify({ state: 'busy', headline: 'x', now: [] }), offered('L1'), 'm', 1)).toThrow(/schema/);
});

test('refresh asks the provider without tools, repairs once, and stores a summary the page reads', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  const good = { state: 'needs_you', headline: 'v2.13 waits on you', now: [{ text: 'Liubomir answered', src: ['L1'] }] };
  await using peer = await scriptedPeer((_body, index) => ({ body: { content: [{ type: 'text', text: index === 0 ? '{"state":"moving"' : JSON.stringify(good) }] } }));
  requestRefresh(db);
  expect(refreshDue(db, cfg)).toBe(true);
  await refreshInitiatives(cfg, db, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(2);
  expect(peer.requests[0]).not.toHaveProperty('tools');
  const data = JSON.parse(peer.requests[0]!.messages[0]!.content as string);
  expect(data).toMatchObject({ kind: 'untrusted_initiative_data', today: '2026-11-18', goal: 'RBAC design accepted by IAM.' });
  expect(data.log.map((entry: { id: string }) => entry.id)).toEqual(['L1', 'L2', 'L3']);
  expect(peer.requests[1]!.messages.at(-1)!.content).toMatch(/rejected/);
  const state = readInitiatives(db, cfg);
  expect(state.initiatives[0]).toMatchObject({ id: 'demo', client: 'acme', error: null, waits: [], summary: { state: 'needs_you', model: 'first/synthetic-small' } });
  expect(state.initiatives[0]!.summary!.now.map((line) => line.text)).toEqual(['Liubomir answered']);
  expect(state.requested).toBe(false);
  expect(refreshDue(db, cfg)).toBe(false);
});

test('tickets naming the initiative note are offered first, ahead of the client\'s newer tickets', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  db.prepare("INSERT INTO ticket(title,client,kb_notes,created_at,last_activity_at) VALUES ('Plan item','acme','[\"01_Projects/demo.md\"]','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z')").run();
  for (let index = 0; index < 31; index++) {
    db.prepare("INSERT INTO ticket(title,client,lifecycle,created_at,last_activity_at) VALUES (?,'acme','active',?,?)").run(`Other ${index}`, AT, AT);
  }
  const good = { state: 'moving', headline: 'x', now: [{ text: 'a', src: ['L1'] }] };
  await using peer = await scriptedPeer(() => ({ body: { content: [{ type: 'text', text: JSON.stringify(good) }] } }));
  requestRefresh(db);
  await refreshInitiatives(cfg, db, { providers: { first: provider(peer.baseURL) } });
  const tickets = JSON.parse(peer.requests[0]!.messages[0]!.content as string).tickets as { id: string; title: string }[];
  expect(tickets).toHaveLength(30);
  expect(tickets[0]).toMatchObject({ id: 'T1', title: 'Plan item' });
});

test('a failed refresh keeps the last summary, shows the error and tries again after half an hour', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  const good = { state: 'moving', headline: 'h', now: [{ text: 'a', src: ['L1'] }] };
  let fail = false;
  await using peer = await scriptedPeer(() => fail ? { status: 503, body: {} } : { body: { content: [{ type: 'text', text: JSON.stringify(good) }] } });
  const providers = { first: provider(peer.baseURL) };
  await refreshInitiatives(cfg, db, { providers });
  fail = true;
  vi.setSystemTime(new Date('2026-11-19T09:00:00Z'));
  expect(refreshDue(db, cfg)).toBe(true);
  await refreshInitiatives(cfg, db, { providers });
  const view = readInitiatives(db, cfg).initiatives[0]!;
  expect(view.summary?.headline).toBe('h');
  expect(view.error).toMatch(/HTTP 503/);
  expect(refreshDue(db, cfg)).toBe(false);
  vi.setSystemTime(new Date('2026-11-19T09:31:00Z'));
  expect(refreshDue(db, cfg)).toBe(true);
});

test('the daily run waits for the hour on weekdays and never runs without initiatives', () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  expect(refreshDue(db, cfg, Date.parse('2026-11-18T06:30:00Z'))).toBe(false);
  expect(refreshDue(db, cfg, Date.parse('2026-11-18T07:00:00Z'))).toBe(true);
  expect(refreshDue(db, cfg, Date.parse('2026-11-21T09:00:00Z'))).toBe(false);
  cfg.initiatives = {};
  requestRefresh(db);
  expect(refreshDue(db, cfg)).toBe(false);
});

test('page opens are counted per local day', () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  markSeen(db, cfg);
  markSeen(db, cfg);
  expect(markSeen(db, cfg, Date.parse('2026-11-19T08:00:00Z'))).toEqual({ '2026-11-18': 2, '2026-11-19': 1 });
  expect(readInitiatives(db, cfg).views).toEqual({ '2026-11-18': 2, '2026-11-19': 1 });
});

test('proposed tickets: new work from the note becomes tickets of the initiative, a returned key is never duplicated, existing tickets are offered', async () => {
  const { cfg } = fixture();
  cfg.overview.propose_tickets = true;
  using db = openDb(cfg.db.path);
  db.prepare("INSERT INTO ticket(title,client,initiative,lifecycle,created_at) VALUES ('Old dismissed idea','acme','demo','dismissed',?)").run(AT);
  const answer = { tickets: [{ key: 'ask-geoff-vault', title: 'Ask Geoff: Vault questions 1-3', summary: 'Sent 17/11, no answer.', ask: 'Get the Vault answers.', proposal: '1. Remind Geoff in writing.' },
    { key: 'ask-geoff-vault', title: 'Ask Geoff again', summary: '', ask: '', proposal: '' }] };
  await using peer = await scriptedPeer((_body, index) => ({ body: { content: [{ type: 'text', text: index === 0 ? 'not json' : JSON.stringify(answer) }] } }));
  const made = await proposeTickets(cfg, db, 'demo', { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(2);
  expect(peer.requests[0]!.system).toContain('ticket list of one initiative');
  const data = JSON.parse(peer.requests[0]!.messages[0]!.content as string);
  expect(data.existing_tickets).toEqual([{ id: 'T1', title: 'Old dismissed idea', lifecycle: 'dismissed' }]);
  expect(data.note).toContain('## goal');
  expect(data.note).not.toContain('## log');
  expect(made).toEqual({ tickets: [2, 2], waits: [], answered: [] });
  expect(db.prepare('SELECT title,client,initiative,origin,lifecycle,kb_notes FROM ticket WHERE id=2').get()).toEqual({ title: 'Ask Geoff: Vault questions 1-3', client: 'acme',
    initiative: 'demo', origin: 'ai', lifecycle: 'proposed', kb_notes: '["01_Projects/demo.md"]' });
});

test('a failed proposal is recorded and leaves the summary of the same run in place', async () => {
  const { cfg } = fixture();
  cfg.overview.propose_tickets = true;
  using db = openDb(cfg.db.path);
  const good = { state: 'moving', headline: 'h', now: [{ text: 'a', src: ['L1'] }] };
  await using peer = await scriptedPeer((body) => ({ body: { content: [{ type: 'text', text: String((body as { system?: string }).system ?? '').includes('ticket list') ? 'broken' : JSON.stringify(good) }] } }));
  requestRefresh(db);
  await refreshInitiatives(cfg, db, { providers: { first: provider(peer.baseURL) } });
  expect(readInitiatives(db, cfg).initiatives[0]).toMatchObject({ error: null, summary: { headline: 'h' } });
  expect(JSON.parse(String(db.prepare("SELECT value FROM setting WHERE key='initiative.proposed:demo'").get()!.value))).toMatchObject({ tickets: [], waits: [], answered: [], error: 'Proposed tickets are not valid JSON of the asked shape; answer starts: broken' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()!.n).toBe(0);
});

test('questions already put become waits citing their log entry: a proposed ask turns into its wait, an unknown entry is dropped, a run again changes nothing', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  db.prepare("INSERT INTO ticket(title,client,initiative,origin,lifecycle,created_at) VALUES ('Ask Geoff: Vault questions 1-3','acme','demo','ai','proposed',?)").run(AT);
  const waits = [{ who: 'Geoff', what: 'Vault questions 1-3', src: 'L2', ticket: 'T1' }, { who: 'Mohamed', what: 'GEN 15.4 staying or removed', src: 'L3', ticket: null },
    { who: 'Ghost', what: 'invented', src: 'L99', ticket: null }];
  await using peer = await scriptedPeer(() => ({ body: { content: [{ type: 'text', text: JSON.stringify({ tickets: [], waits, answered: [] }) }] } }));
  const options = { providers: { first: provider(peer.baseURL) } };
  expect(await proposeTickets(cfg, db, 'demo', options)).toEqual({ tickets: [], waits: [1, 2], answered: [] });
  expect(db.prepare('SELECT id,title,lifecycle,report,report_line,report_at,origin FROM ticket ORDER BY id').all()).toEqual([
    { id: 1, title: 'Waiting on Geoff: Vault questions 1-3', lifecycle: 'active', report: 'waiting_them', report_line: 'Geoff: Vault questions 1-3', report_at: '2026-11-17T12:00:00.000000Z', origin: 'ai' },
    { id: 2, title: 'Waiting on Mohamed: GEN 15.4 staying or removed', lifecycle: 'active', report: 'waiting_them', report_line: 'Mohamed: GEN 15.4 staying or removed', report_at: '2026-11-11T12:00:00.000000Z', origin: 'ai' }]);
  expect(String(db.prepare('SELECT summary FROM ticket WHERE id=2').get()!.summary)).toBe('Asked 11/11: SENT Mohamed 4): standard section 1 still maps GEN 15.4, staying or removed?');
  expect(readInitiatives(db, cfg).initiatives[0]!.waits.map((wait) => [wait.who, wait.days])).toEqual([['Geoff', 1], ['Mohamed', 5]]);
  // Again: the link to T1, now a wait, creates nothing; the same Mohamed wait returns its ticket
  expect(await proposeTickets(cfg, db, 'demo', options)).toEqual({ tickets: [], waits: [2], answered: [] });
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()!.n).toBe(2);
  const offered = JSON.parse(peer.requests[1]!.messages[0]!.content as string).existing_tickets;
  expect(offered[0]).toEqual({ id: 'T1', title: 'Waiting on Geoff: Vault questions 1-3', lifecycle: 'active', waiting_on: 'Geoff: Vault questions 1-3', since: '2026-11-17' });
});

test('an answer in the log moves its wait to Needs you, only from an entry dated on or after the question', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  const answers = [{ tickets: [], waits: [{ who: 'Geoff', what: 'Vault questions 1-3', src: 'L2' }, { who: 'Mohamed', what: 'GEN 15.4', src: 'L3' }], answered: [] },
    { tickets: [], waits: [], answered: [{ ticket: 'T1', src: 'L3' }, { ticket: 'T2', src: 'L1' }, { ticket: 'T9', src: 'L1' }] }];
  await using peer = await scriptedPeer((_body, index) => ({ body: { content: [{ type: 'text', text: JSON.stringify(answers[Math.min(index, 1)]) }] } }));
  const options = { providers: { first: provider(peer.baseURL) } };
  await proposeTickets(cfg, db, 'demo', options);
  expect(await proposeTickets(cfg, db, 'demo', options)).toEqual({ tickets: [], waits: [], answered: [2] });
  expect(db.prepare('SELECT id,report,report_line FROM ticket ORDER BY id').all()).toEqual([
    { id: 1, report: 'waiting_them', report_line: 'Geoff: Vault questions 1-3' },
    { id: 2, report: 'needs_you', report_line: 'Answered 18/11: SENT Liubomir: thanks, point taken.' }]);
  expect(readInitiatives(db, cfg).initiatives[0]!.waits.map((wait) => wait.who)).toEqual(['Geoff']);
  expect(await proposeTickets(cfg, db, 'demo', options)).toEqual({ tickets: [], waits: [], answered: [] });
});

test('one log entry that put several questions to the same person gives one wait each; only the same question twice leaves AI as dismissed', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  for (const title of ['Ask Geoff: kv-ocp-platform readers', 'Ask Geoff: role id', 'Ask Geoff: rebuild delete', 'Ask Geoff again: role id'])
    db.prepare("INSERT INTO ticket(title,client,initiative,origin,lifecycle,created_at) VALUES (?,'acme','demo','ai','proposed',?)").run(title, AT);
  const waits = [{ who: 'Geoff', what: 'kv-ocp-platform readers', src: 'L2', ticket: 'T1' }, { who: 'Geoff', what: 'role id', src: 'L2', ticket: 'T2' },
    { who: 'Geoff', what: 'rebuild delete', src: 'L2', ticket: 'T3' }, { who: 'Geoff', what: 'Role ID', src: 'L2', ticket: 'T4' }];
  await using peer = await scriptedPeer(() => ({ body: { content: [{ type: 'text', text: JSON.stringify({ tickets: [], waits, answered: [] }) }] } }));
  expect(await proposeTickets(cfg, db, 'demo', { providers: { first: provider(peer.baseURL) } })).toEqual({ tickets: [], waits: [1, 2, 3, 2], answered: [] });
  expect(db.prepare('SELECT id,lifecycle,report_line FROM ticket ORDER BY id').all()).toEqual([
    { id: 1, lifecycle: 'active', report_line: 'Geoff: kv-ocp-platform readers' }, { id: 2, lifecycle: 'active', report_line: 'Geoff: role id' },
    { id: 3, lifecycle: 'active', report_line: 'Geoff: rebuild delete' }, { id: 4, lifecycle: 'dismissed', report_line: 'Already asked: same as wait #2' }]);
});

test('work that cannot move until an asked answer waits on it with its own title and texts, two pieces of work can wait on one answer, and a reworded wait linked to a listed wait creates nothing', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  for (const title of ['Resize MySQL prod (204 USD/m)', 'MySQL 8.0 to 8.4 on 4 servers'])
    db.prepare("INSERT INTO ticket(title,client,initiative,origin,lifecycle,summary,proposal,created_at) VALUES (?,'acme','demo','ai','proposed','Facts','1. Window\n2. Resize',?)").run(title, AT);
  const answers = [{ waits: [{ who: 'Mohamed', what: 'maintenance window', src: 'L3', ticket: 'T1' }, { who: 'Mohamed', what: 'maintenance window', src: 'L3', ticket: 'T2' }] },
    { waits: [{ who: 'Mohamed', what: 'the maintenance window for both', src: 'L3', ticket: 'T1' }] }];
  await using peer = await scriptedPeer((_body, index) => ({ body: { content: [{ type: 'text', text: JSON.stringify(answers[Math.min(index, 1)]) }] } }));
  const options = { providers: { first: provider(peer.baseURL) } };
  expect(await proposeTickets(cfg, db, 'demo', options)).toEqual({ tickets: [], waits: [1, 2], answered: [] });
  expect(db.prepare('SELECT id,title,summary,proposal,report,report_line FROM ticket ORDER BY id').all()).toEqual([
    { id: 1, title: 'Resize MySQL prod (204 USD/m)', summary: 'Facts', proposal: '1. Window\n2. Resize', report: 'waiting_them', report_line: 'Mohamed: maintenance window' },
    { id: 2, title: 'MySQL 8.0 to 8.4 on 4 servers', summary: 'Facts', proposal: '1. Window\n2. Resize', report: 'waiting_them', report_line: 'Mohamed: maintenance window' }]);
  expect(readInitiatives(db, cfg).initiatives[0]!.waits.map((wait) => [wait.who, wait.days])).toEqual([['Mohamed', 5], ['Mohamed', 5]]);
  expect(await proposeTickets(cfg, db, 'demo', options)).toEqual({ tickets: [], waits: [], answered: [] });
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()!.n).toBe(2);
});
