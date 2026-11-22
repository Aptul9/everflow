import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openDb } from '../src/core/db.ts';
import { storedTickets, ticketCards } from '../src/core/initiative-state.ts';
import { localTime, markSeen, noteContext, noteTickets, parseSummary, readInitiatives, refreshDue, refreshInitiatives, requestRefresh, syncTickets, workingDays } from '../src/core/initiatives.ts';
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

test('items citing no offered entry are dropped and counted; waits date from their oldest source', () => {
  const summary = parseSummary(JSON.stringify({
    state: 'waiting_them', headline: 'Mohamed holds four questions',
    now: [{ text: 'Real line', src: ['L1'] }, { text: 'Invented line', src: ['L99'] }, { text: 'No source', src: [] }],
    waits: [{ who: 'Mohamed', owes: 'them', what: 'questions 1-4', src: ['L2', 'L1'] }],
    next: [{ owner: 'ai', text: 'Remind Mohamed', src: ['L2'], draft: 'Hi Mohamed, any news on 1-4?' }, { owner: 'you', text: 'Send v2.13', src: ['T7'] }],
    done: [],
  }), offered('L1', 'L2', 'T7'), 'first/model', 3, '2026-11-18');
  expect(summary.now.map((line) => line.text)).toEqual(['Real line']);
  expect(summary.rejected).toBe(2);
  expect(summary.waits[0]).toMatchObject({ who: 'Mohamed', owes: 'them', since: '2026-11-11', days: 5 });
  expect(summary.next.map((next) => [next.owner, next.draft])).toEqual([['ai', 'Hi Mohamed, any news on 1-4?'], ['you', null]]);
});

test('a summary with no sourced now line, or not JSON, is refused', () => {
  expect(() => parseSummary('not json', offered('L1'), 'm', 1, '2026-11-18')).toThrow(/not JSON/);
  expect(() => parseSummary(JSON.stringify({ state: 'moving', headline: 'x', now: [{ text: 'a', src: ['L5'] }] }), offered('L1'), 'm', 1, '2026-11-18')).toThrow(/No line of now/);
  expect(() => parseSummary(JSON.stringify({ state: 'busy', headline: 'x', now: [] }), offered('L1'), 'm', 1, '2026-11-18')).toThrow(/schema/);
});

test('refresh asks the provider without tools, repairs once, and stores a summary the page reads', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  const good = { state: 'needs_you', headline: 'v2.13 waits on you', now: [{ text: 'Liubomir answered', src: ['L1'] }],
    waits: [{ who: 'Geoff', owes: 'them', what: 'Vault Qs 1-3', src: ['L2'] }], next: [], done: [] };
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
  expect(state.initiatives[0]).toMatchObject({ id: 'demo', client: 'acme', error: null, summary: { state: 'needs_you', model: 'first/synthetic-small' } });
  expect(state.initiatives[0]!.summary!.waits[0]).toMatchObject({ who: 'Geoff', since: '2026-11-17', days: 1 });
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
  const good = { state: 'moving', headline: 'x', now: [{ text: 'a', src: ['L1'] }], waits: [], next: [], done: [] };
  await using peer = await scriptedPeer(() => ({ body: { content: [{ type: 'text', text: JSON.stringify(good) }] } }));
  requestRefresh(db);
  await refreshInitiatives(cfg, db, { providers: { first: provider(peer.baseURL) } });
  const tickets = JSON.parse(peer.requests[0]!.messages[0]!.content as string).tickets as { id: string; title: string }[];
  expect(tickets).toHaveLength(30);
  expect(tickets[0]).toMatchObject({ id: 'T1', title: 'Plan item' });
});

const TICKETS = `
## Tickets
- [ ] 0.1 Delete docs app (429 USD/m) | you: Mirko | since 2026-11-16 | ask: is it Maruca's documentation?
- [ ] 0.4 Serverless dbs to DTU | you
- [ ] 2.1 AU without SFTP | them: Andrè | since 2026-11-11 | ask: can api-au go?
- [ ] X.3 Price the 2027 expiry | ai
- [ ] R.7 Hybrid Benefit | them | ask: licence count
- [x] 0.2 TS decommission | done 2026-11-17
- [x] 0.0 Old cleanup | done 2026-11-02
- not a ticket line
`;

test('note tickets: owner, person, since, ask and done date per line, other lines ignored', () => {
  const tickets = noteTickets(NOTE + TICKETS);
  expect(tickets.map((ticket) => [ticket.id, ticket.owner, ticket.who, ticket.since, ticket.done, ticket.done_at])).toEqual([
    ['0.1', 'you', 'Mirko', '2026-11-16', false, null], ['0.4', 'you', null, null, false, null], ['2.1', 'them', 'Andrè', '2026-11-11', false, null],
    ['X.3', 'ai', null, null, false, null], ['R.7', 'them', 'them', null, false, null], ['0.2', 'you', null, null, true, '2026-11-17'],
    ['0.0', 'you', null, null, true, '2026-11-02']]);
  expect(tickets[0]).toMatchObject({ title: 'Delete docs app (429 USD/m)', ask: "is it Maruca's documentation?" });
  expect(noteTickets(NOTE)).toEqual([]);
});

test('note tickets replace the summary cards: map and Them for what is owed, AI and You for the rest, Done for the last 7 days', async () => {
  const { cfg } = fixture();
  writeFileSync(join(cfg.vault.path, '01_Projects/demo.md'), NOTE + TICKETS);
  using db = openDb(cfg.db.path);
  const good = { state: 'moving', headline: 'Plan running', now: [{ text: 'AU waits on Andrè', src: ['K2.1'] }],
    waits: [{ who: 'Geoff', owes: 'them', what: 'Vault Qs 1-3', src: ['L2'] }], next: [{ owner: 'you', text: 'Model step', src: ['L1'] }], done: [] };
  await using peer = await scriptedPeer(() => ({ body: { content: [{ type: 'text', text: JSON.stringify(good) }] } }));
  syncTickets(cfg, db);
  requestRefresh(db);
  await refreshInitiatives(cfg, db, { providers: { first: provider(peer.baseURL) } });
  const data = JSON.parse(peer.requests[0]!.messages[0]!.content as string);
  expect(data.plan_tickets.map((ticket: { id: string }) => ticket.id)).toEqual(['K0.1', 'K0.4', 'K2.1', 'KX.3', 'KR.7', 'K0.2', 'K0.0']);
  const summary = readInitiatives(db, cfg).initiatives[0]!.summary!;
  expect(summary.now.map((line) => line.text)).toEqual(['AU waits on Andrè']);
  expect(summary.waits.map((wait) => [wait.who, wait.owes, wait.text, wait.days])).toEqual([
    ['Mirko', 'you', "0.1 Delete docs app (429 USD/m): is it Maruca's documentation?", 2],
    ['Andrè', 'them', '2.1 AU without SFTP: can api-au go?', 5],
    ['them', 'them', 'R.7 Hybrid Benefit: licence count', 0]]);
  expect(summary.next.map((next) => [next.owner, next.text])).toEqual([
    ['you', "0.1 Delete docs app (429 USD/m). Mirko: is it Maruca's documentation?"], ['you', '0.4 Serverless dbs to DTU'], ['ai', 'X.3 Price the 2027 expiry']]);
  expect(summary.done.map((line) => line.text)).toEqual(['0.2 TS decommission']);
  expect(summary.waits[0]!.sources).toEqual([{ id: 'K0.1', date: '2026-11-16', text: 'Ticket 0.1: Delete docs app (429 USD/m)' }]);
});

test('waits with the same person and ask become one card; tickets carry after and the row of their table', () => {
  const note = `${NOTE}
## Tickets
- [ ] R.1 Reservation D8as_v5 | them: Roar admin | since 2026-11-21 | ask: ok to buy 1Y reservations
- [ ] R.3 Reservation P1v3 | them: Roar admin | since 2026-11-20 | ask: ok to buy 1Y reservations | after: 1.5
- [ ] 2.1 AU without SFTP | them: Andrè | since 2026-11-19 | ask: can api-au go?

## Plan
| # | Intervention | USD/m | RTO | T |
|---|---|---:|---|---|
| R.1 | RI 1Y D8as_v5 x3 | 349 | none | #94 |
| 2.1 | AU decommission | ~760 | api-au unreachable | |
`;
  const tickets = noteTickets(note);
  expect(tickets[0]!.details).toEqual([{ label: 'Intervention', value: 'RI 1Y D8as_v5 x3' }, { label: 'USD/m', value: '349' }, { label: 'RTO', value: 'none' }]);
  expect(tickets[1]).toMatchObject({ after: '1.5', details: [] });
  const empty = { state: 'moving' as const, headline: 'h', now: [], waits: [], next: [], done: [], rejected: 0, entries: 0, model: 'm' };
  const cards = ticketCards(empty, tickets, '2026-11-23');
  expect(cards.waits.map((wait) => [wait.who, wait.text, wait.since, wait.days, wait.tickets!.map((ticket) => ticket.id)])).toEqual([
    ['Roar admin', 'ok to buy 1Y reservations (R.1, R.3)', '2026-11-20', 1, ['R.1', 'R.3']],
    ['Andrè', '2.1 AU without SFTP: can api-au go?', '2026-11-19', 2, ['2.1']]]);
  expect(cards.waits[0]!.sources.map((item) => item.id)).toEqual(['KR.1', 'KR.3']);
  expect(cards.waits[1]!.tickets![0]!.details).toEqual([{ label: 'Intervention', value: 'AU decommission' }, { label: 'USD/m', value: '~760' }, { label: 'RTO', value: 'api-au unreachable' }]);
});

test('note tickets are read again only when the note changes', () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  const path = join(cfg.vault.path, '01_Projects/demo.md');
  writeFileSync(path, NOTE + TICKETS);
  utimesSync(path, new Date('2026-11-18T08:00:00Z'), new Date('2026-11-18T08:00:00Z'));
  syncTickets(cfg, db);
  expect(storedTickets(db, 'demo').tickets).toHaveLength(7);
  writeFileSync(path, NOTE + '\n## Tickets\n- [ ] 9.9 Only one | you\n');
  utimesSync(path, new Date('2026-11-18T08:00:00Z'), new Date('2026-11-18T08:00:00Z'));
  syncTickets(cfg, db);
  expect(storedTickets(db, 'demo').tickets).toHaveLength(7);
  utimesSync(path, new Date('2026-11-18T08:05:00Z'), new Date('2026-11-18T08:05:00Z'));
  syncTickets(cfg, db);
  expect(storedTickets(db, 'demo').tickets.map((ticket) => ticket.id)).toEqual(['9.9']);
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
