// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { guidePerson, InitiativesPage } from '../../src/components/initiatives/initiatives-page.tsx';
import type { Explainer, GuideState, InitiativesState, InitiativeView, OverviewState } from '../../src/lib/web-types.ts';
import { card, uiState } from './fixtures.ts';

let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json({ requested: true })
    : String(input).startsWith('/api/guide/') ? new Response('{}', { status: 404 }) : String(input).startsWith('/api/state') ? Response.json(board()) : Response.json(state()));
  vi.stubGlobal('fetch', fetcher);
  window.sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ACTION = 'a'.repeat(64);
const props = () => ({ initialState: state(), initialBoard: board(), initialEtag: '"synthetic"', token: ACTION, initialNow: Date.parse('2026-11-18T09:00:00Z') });
const source = (id: string, date: string, text: string) => ({ id, date, text });
function acme(): InitiativeView {
  return { id: 'acme-access', title: 'Access', client: 'acme', note: '01_Projects/acme-access.md', at: '2026-11-18T07:00:00.000000Z', error: null, error_at: null,
    summary: { state: 'waiting_them', headline: 'Alice silent on 4 questions', model: 'm', entries: 40, rejected: 1,
      now: [{ text: 'Standard waits documentation approval', sources: [source('L1', '2026-11-18', '2026-11-18 09:48 - Pat: standard pending')] }] },
    waits: [
      { who: 'Alice', owes: 'them', text: 'questions 1-4', since: '2026-11-10', days: 6, sources: [source('T104', '2026-11-10', 'Ticket #104: Bob reviews catalogue')] },
      { who: 'Bob', owes: 'them', text: 'catalogue review', since: '2026-11-18', days: 0, sources: [source('T107', '2026-11-18', 'Ticket #107: Catalogue review')] }] };
}

function state(): InitiativesState {
  return { initiatives: [acme(), { id: 'example-platform', title: 'Platform project', client: 'example', note: '01_Projects/example/example-platform.md', at: null, summary: null,
    error: 'Provider first HTTP 503', error_at: '2026-11-18T07:01:00.000000Z', waits: [] }], today: '2026-11-18', views: {}, requested: false, refreshing: false, providers: true };
}

// The board state: the board's own tickets plus acme's tickets, which show only on the Overview
function board(): OverviewState {
  const base = uiState();
  return { ...base, initiatives: { 'acme-access': {
    needs_you: [card(101, { title: 'Ask Alice for questions 1-4', client: 'acme' })],
    failed: [card(102, { title: 'Publish catalogue', client: 'acme', lifecycle: 'active', stage: 'Failed' })],
    working: [card(103, { title: 'Rebuild v2.14', client: 'acme', lifecycle: 'active', stage: 'Working', chat_running: true, session_id: 'ses_synthetic' })],
    waiting_them: [card(104, { title: 'Bob reviews catalogue', client: 'acme', lifecycle: 'active', stage: 'Waiting on them', report: 'waiting_them', report_line: 'Asked Bob on Teams' })],
    done_today: [card(105, { title: 'Catalogue v2.13 built', client: 'acme', lifecycle: 'done', stage: 'Done', closed_at: '2026-11-17T09:00:00Z' })],
    skipped: [card(106, { title: 'Old idea', client: 'acme', lifecycle: 'dismissed', stage: 'Dismissed', closed_at: '2026-11-17T09:00:00Z' })],
  }, 'example-platform': { needs_you: [], failed: [], working: [], waiting_them: [], done_today: [], skipped: [] } } };
}

test('an initiative shows its tickets in the board columns: You with failed ones, Working, Them, Done this week, Skipped', async () => {
  render(<InitiativesPage {...props()} />);
  const detail = screen.getByRole('region', { name: 'acme Access' });
  const column = (name: string) => within(detail).getByRole('region', { name });
  const ids = (name: string) => [...column(name).querySelectorAll('article[data-ticket-id]')].map((item) => item.getAttribute('data-ticket-id'));
  expect(ids('You (2)')).toEqual(['101', '102']);
  expect(ids('Working (1)')).toEqual(['103']);
  expect(ids('Them (1)')).toEqual(['104']);
  expect(ids('Done this week (1)')).toEqual(['105']);
  expect(ids('Skipped (1)')).toEqual(['106']);
  expect(column('Them (1)').textContent).toContain('Asked Bob on Teams');
  expect(screen.getByRole('button', { pressed: true }).textContent).toContain('You 2Working 1Them 1');
  await userEvent.click(within(column('You (2)')).getAllByRole('button', { name: 'Start' })[0]!);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/ticket/101/start', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-everflow-token': ACTION }) })));
  await userEvent.click(within(column('You (2)')).getByRole('button', { name: 'Expand ticket #101' }));
  expect(within(screen.getByRole('dialog')).getByRole('heading', { name: 'Ask Alice for questions 1-4' })).toBeTruthy();
});

test('the detail draws who owes what and the sources of the current lines', async () => {
  render(<InitiativesPage {...props()} />);
  const detail = screen.getByRole('region', { name: 'acme Access' });
  expect(screen.getAllByRole('button', { pressed: true })[0]!.textContent).toContain('Waiting on them · 6d');
  expect(within(detail).getByRole('group', { name: /Open requests/ }).getAttribute('aria-label')).toBe('Open requests: Alice 1, Bob 1');
  expect(detail.querySelector('[data-person="Alice"]')?.getAttribute('data-tone')).toBe('overdue');
  expect(detail.querySelector('[data-person="Bob"]')?.getAttribute('data-tone')).toBe('them');
  expect(detail.textContent).toContain('1 items dropped for citing no source');
  await userEvent.click(within(within(detail).getByRole('list')).getByRole('button', { name: 'Fonti (1)' }));
  expect(screen.getByRole('dialog').textContent).toContain('18/11/2026 · Registro del progettoPat: standard pending');
});

test('overview dates use Rome time', () => {
  render(<InitiativesPage {...props()} />);
  expect(screen.getByText('Updated 18/11/2026 08:00')).toBeTruthy();
});

test('a failed initiative says so, the open is counted once a day, and Refresh asks the daemon', async () => {
  render(<InitiativesPage {...props()} />);
  await userEvent.click(screen.getByRole('button', { name: /Platform project/ }));
  const detail = screen.getByRole('region', { name: 'example Platform project' });
  expect(within(detail).getAllByRole('alert')[0]!.textContent).toContain('HTTP 503');
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/initiatives/seen', expect.objectContaining({ method: 'POST' })));
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/initiatives/refresh', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-everflow-token': ACTION }) })));
  cleanup();
  render(<InitiativesPage {...props()} />);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/initiatives/seen')).toHaveLength(1);
});

test('every card links to its guide, saying when it is still being prepared', () => {
  render(<InitiativesPage {...props()} />);
  const link = screen.getAllByRole('link', { name: 'Guida in preparazione' });
  expect(link.map((item) => item.getAttribute('href'))).toContain('/overview/acme-access');
  expect(link.map((item) => item.getAttribute('href'))).toContain('/overview/example-platform');
});

test('clicking a person fades the others and lists what they owe; Torna alla mappa resets', async () => {
  render(<InitiativesPage {...props()} />);
  const detail = screen.getByRole('region', { name: 'acme Access' });
  await userEvent.click(detail.querySelector('[data-person="Alice"]')!);
  expect(detail.querySelector('[data-person="Bob"]')!.getAttribute('data-dim')).toBe('true');
  expect(detail.querySelector('[data-person="Alice"]')!.getAttribute('data-dim')).toBeNull();
  expect(detail.querySelector('[data-focus-waits]')!.textContent).toContain('questions 1-4');
  expect(detail.querySelector('[data-focus-waits]')!.textContent).toContain('6 working days');
  await userEvent.click(within(detail).getByRole('button', { name: 'Torna alla mappa' }));
  expect(detail.querySelector('[data-focus-waits]')).toBeNull();
  expect(detail.querySelectorAll('[data-dim="true"]')).toHaveLength(0);
});
function guide(): GuideState {
  const ex: Explainer = {
    title: 'Access', one_liner: '', why: [], role: '', teams: [], concepts: [], glossary: [], warnings: [], ask_who: [], phases: [], timeline: [], blocked_by: [], next_you: [], notes: [], rejected: 0, model: 'test',
    people: [{ id: 'alice', name: 'Alice Example', short: 'Alice', team: '', role: '', plain: '', ask_for: '', how: '', src: ['G1'] }],
    goal: { label: 'Goal', plain: '' }, sources: { G1: { id: 'G1', kind: 'log', text: '2026-11-11 16:53 - SENT Alice 4)' } },
    graph: { nodes: [{ id: 'questions', kind: 'answer', label: 'questions 1-4', plain: '', status: 'open', owner: 'alice', since: null, src: ['G1'] }],
      edges: [{ from: 'alice', to: 'questions', kind: 'owes', why: 'Request', src: ['G1'] }, { from: 'questions', to: 'goal', kind: 'unblocks', why: 'Evidence', src: ['G1'] }] },
  };
  return { initiative: acme(), today: '2026-11-18', at: null, explainer: ex, error: null, error_at: null, requested: false, running: false, providers: true, dismissed: [], flagged: [] };
}

test('with a guide, clicking a person on the map shows the nodes they owe in the dependency graph', async () => {
  fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json({ requested: true })
    : String(input).includes('/api/guide/acme-access') ? Response.json(guide()) : String(input).startsWith('/api/state') ? Response.json(board()) : new Response('{}', { status: 404 }));
  render(<InitiativesPage {...props()} />);
  await waitFor(() => expect(screen.getAllByRole('link', { name: 'Apri la guida' }).length).toBeGreaterThan(0));
  const detail = screen.getByRole('region', { name: 'acme Access' });
  await userEvent.click(detail.querySelector('[data-person="Alice"]')!);
  expect(detail.querySelector('[data-graph]')?.getAttribute('data-focus')).toBe('alice');
  await userEvent.click(within(detail).getByRole('button', { name: 'Togli la selezione (Esc)' }));
  expect(detail.querySelector('[data-graph]')).toBeNull();
});

test('ambiguous short names never select a guide person', () => {
  const ex = guide().explainer!;
  ex.people.push({ ...ex.people[0]!, id: 'other', name: 'Alice Other' });
  expect(guidePerson(ex, 'Alice')).toBeNull();
  expect(guidePerson(ex, 'Alice Example')).toBe('alice');
  expect(guidePerson(ex, 'Alice Stranger')).toBeNull();
});

test('the overview person map supports keyboard activation and reset', async () => {
  render(<InitiativesPage {...props()} />);
  const detail = screen.getByRole('region', { name: 'acme Access' });
  const alice = detail.querySelector<HTMLElement>('[data-person="Alice"]')!;
  alice.focus();
  await userEvent.keyboard('{Enter}');
  expect(detail.querySelector('[data-focus-waits]')?.textContent).toContain('questions 1-4');
  alice.focus();
  await userEvent.keyboard(' ');
  expect(detail.querySelector('[data-focus-waits]')).toBeNull();
});
