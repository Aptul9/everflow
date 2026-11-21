// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { guidePerson, InitiativesPage } from '../../src/components/initiatives/initiatives-page.tsx';
import type { Explainer, GuideState, InitiativesState, InitiativeView } from '../../src/lib/web-types.ts';

let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json({ requested: true })
    : String(input).startsWith('/api/guide/') ? new Response('{}', { status: 404 }) : Response.json(state()));
  vi.stubGlobal('fetch', fetcher);
  window.sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ACTION = 'a'.repeat(64);
const props = () => ({ initialState: state(), token: ACTION });
const source = (id: string, date: string, text: string) => ({ id, date, text });

function acme(): InitiativeView {
  return { id: 'acme-access', title: 'Access', client: 'acme', note: '01_Projects/acme-access.md', at: '2026-11-18T07:00:00.000000Z', error: null, error_at: null,
    summary: { state: 'waiting_them', headline: 'Alice silent on 4 questions', model: 'm', entries: 40, rejected: 1,
      now: [{ text: 'Standard waits documentation approval', sources: [source('L1', '2026-11-18', '2026-11-18 09:48 - Pat: standard pending')] }],
      waits: [
        { who: 'Alice', owes: 'them', text: 'questions 1-4', since: '2026-11-11', days: 5 + 1, sources: [source('L9', '2026-11-11', '2026-11-11 16:53 - SENT Alice 4)')] },
        { who: 'Bob', owes: 'you', text: 'catalogue v2.13', since: '2026-11-18', days: 0, sources: [source('L2', '2026-11-18', '2026-11-18 - Built v2.13')] },
      ],
      next: [{ owner: 'ai', text: 'Reminder to Alice', draft: 'Hi Alice, any news on 1-4?', sources: [source('L9', '2026-11-11', 'x')] },
        { owner: 'you', text: 'Send v2.13 to Bob', draft: null, sources: [source('L2', '2026-11-18', 'y')] }],
      done: [{ text: 'Catalogue v2.13 built', sources: [source('L2', '2026-11-18', 'y')] }] } };
}

function state(): InitiativesState {
  return { initiatives: [acme(), { id: 'example-platform', title: 'Platform project', client: 'example', note: '01_Projects/example/example-platform.md', at: null, summary: null,
    error: 'Provider first HTTP 503', error_at: '2026-11-18T07:01:00.000000Z' }], today: '2026-11-18', views: {}, requested: false, refreshing: false, providers: true };
}

test('cards show each initiative state; the detail draws who owes what, the board and the sources', async () => {
  render(<InitiativesPage {...props()} />);
  const cards = screen.getAllByRole('button', { pressed: true });
  expect(cards).toHaveLength(1);
  expect(cards[0]!.textContent).toContain('Waiting on them · 6d');
  const detail = screen.getByRole('region', { name: 'acme Access' });
  expect(within(detail).getByRole('group', { name: /Open requests/ }).getAttribute('aria-label')).toBe('Open requests: Alice 1, Bob 1');
  expect(detail.querySelector('[data-person="Alice"]')?.getAttribute('data-tone')).toBe('overdue');
  expect(detail.querySelector('[data-person="Bob"]')?.getAttribute('data-tone')).toBe('you');
  expect(within(detail).getByRole('region', { name: 'Them (1)' }).textContent).toContain('6 working days');
  expect(within(detail).getByRole('region', { name: 'You (1)' }).textContent).toContain('Send v2.13 to Bob');
  expect(detail.textContent).toContain('1 items dropped for citing no source');
  await userEvent.click(within(within(detail).getByRole('list')).getByRole('button', { name: 'Fonti (1)' }));
  expect(screen.getByRole('dialog').textContent).toContain('18/11/2026 · Registro del progettoPat: standard pending');
  expect(screen.getByRole('dialog').textContent).not.toContain('2026-11-18 09:48');
  await userEvent.click(within(within(detail).getByRole('region', { name: 'AI (1)' })).getByRole('button', { name: 'Draft' }));
  expect(detail.textContent).toContain('Hi Alice, any news on 1-4?');
});

test('overview dates use Rome time', () => {
  render(<InitiativesPage {...props()} />);
  expect(screen.getByText('Updated 18/11/2026 08:00')).toBeTruthy();
});

test('a failed initiative says so, the open is counted once a day, and Refresh asks the daemon', async () => {
  render(<InitiativesPage {...props()} />);
  await userEvent.click(screen.getByRole('button', { name: /Platform project/ }));
  const detail = screen.getByRole('region', { name: 'example Platform project' });
  expect(within(detail).getByRole('alert').textContent).toContain('HTTP 503');
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

test('a Them card focuses its person on the map', async () => {
  render(<InitiativesPage {...props()} />);
  const detail = screen.getByRole('region', { name: 'acme Access' });
  await userEvent.click(within(within(detail).getByRole('region', { name: 'Them (1)' })).getByRole('button', { name: 'Show what Alice owes' }));
  expect(detail.querySelector('[data-person="Bob"]')!.getAttribute('data-dim')).toBe('true');
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

test('a board card focuses only its uniquely matching node with the same source text', async () => {
  fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json({ requested: true })
    : String(input).includes('/api/guide/acme-access') ? Response.json(guide()) : new Response('{}', { status: 404 }));
  render(<InitiativesPage {...props()} />);
  await waitFor(() => expect(screen.getAllByRole('link', { name: 'Apri la guida' }).length).toBeGreaterThan(0));
  const detail = screen.getByRole('region', { name: 'acme Access' });
  await userEvent.click(within(detail).getByRole('button', { name: 'Show what Alice owes' }));
  expect(detail.querySelector('[data-graph]')?.getAttribute('data-focus')).toBe('questions');
  expect(detail.querySelector('[data-edge="questions>goal"]')?.getAttribute('data-live')).toBe('true');
  expect(within(detail).queryAllByRole('button', { name: 'Segnala come sbagliato' })).toHaveLength(0);
  await userEvent.click(within(detail).getByRole('button', { name: 'Togli la selezione (Esc)' }));
  await userEvent.click(within(within(detail).getByRole('region', { name: 'AI (1)' })).getByRole('button', { name: 'Mostra dipendenze della scheda' }));
  expect(detail.querySelector('[data-focus-line]')?.textContent).toContain('Nessuna dipendenza documentata');
  expect(detail.querySelector('[data-graph]')).toBeNull();
});

test('ambiguous short names never select a guide person', () => {
  const ex = guide().explainer!;
  ex.people.push({ ...ex.people[0]!, id: 'other', name: 'Alice Other' });
  expect(guidePerson(ex, 'Alice')).toBeNull();
  expect(guidePerson(ex, 'Alice Example')).toBe('alice');
  expect(guidePerson(ex, 'Alice Stranger')).toBeNull();
});

test('matching source IDs with different source text do not link a board card', async () => {
  const data = guide();
  const ex = data.explainer!;
  ex.sources = { L9: { id: 'L9', kind: 'log', text: 'Different log entry' } };
  ex.graph.nodes[0]!.src = ['L9'];
  fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json({ requested: true })
    : String(input).includes('/api/guide/acme-access') ? Response.json(data) : new Response('{}', { status: 404 }));
  render(<InitiativesPage {...props()} />);
  await waitFor(() => expect(screen.getAllByRole('link', { name: 'Apri la guida' }).length).toBeGreaterThan(0));
  const detail = screen.getByRole('region', { name: 'acme Access' });
  await userEvent.click(within(detail).getByRole('button', { name: 'Show what Alice owes' }));
  expect(detail.querySelector('[data-focus-line]')?.textContent).toContain('Nessuna dipendenza documentata');
  expect(detail.querySelector('[data-graph]')).toBeNull();
});

test('a wait card does not select a node owed by a different person', async () => {
  const data = guide();
  data.explainer!.graph.edges[0]!.from = 'you';
  fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json({ requested: true })
    : String(input).includes('/api/guide/acme-access') ? Response.json(data) : new Response('{}', { status: 404 }));
  render(<InitiativesPage {...props()} />);
  await waitFor(() => expect(screen.getAllByRole('link', { name: 'Apri la guida' }).length).toBeGreaterThan(0));
  const detail = screen.getByRole('region', { name: 'acme Access' });
  await userEvent.click(within(detail).getByRole('button', { name: 'Show what Alice owes' }));
  expect(detail.querySelector('[data-focus-line]')?.textContent).toContain('Nessuna dipendenza documentata');
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
