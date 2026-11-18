// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { InitiativesPage } from '../../src/components/initiatives/initiatives-page.tsx';
import type { InitiativesState, InitiativeView } from '../../src/lib/web-types.ts';

let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json({ requested: true }) : Response.json(state()));
  vi.stubGlobal('fetch', fetcher);
  window.sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ACTION = 'a'.repeat(64);
const props = () => ({ initialState: state(), token: ACTION });
const source = (id: string, date: string, text: string) => ({ id, date, text });

function tesco(): InitiativeView {
  return { id: 'tesco-ocp-iam', title: 'OCP IAM', client: 'tesco', note: '01_Projects/tesco-ocp-virt-iam.md', at: '2026-11-18T07:00:00.000000Z', error: null, error_at: null,
    summary: { state: 'waiting_them', headline: 'Mohamed silent on 4 questions', model: 'm', entries: 40, rejected: 1,
      now: [{ text: 'Standard waits Tescopedia approval', sources: [source('L1', '2026-11-18', '2026-11-18 09:48 - Liubomir: standard pending')] }],
      waits: [
        { who: 'Mohamed', owes: 'them', text: 'questions 1-4', since: '2026-11-11', days: 5 + 1, sources: [source('L9', '2026-11-11', '2026-11-11 16:53 - SENT Mohamed 4)')] },
        { who: 'Duncan', owes: 'you', text: 'catalogue v2.13', since: '2026-11-18', days: 0, sources: [source('L2', '2026-11-18', '2026-11-18 - Built v2.13')] },
      ],
      next: [{ owner: 'ai', text: 'Reminder to Mohamed', draft: 'Hi Mohamed, any news on 1-4?', sources: [source('L9', '2026-11-11', 'x')] },
        { owner: 'you', text: 'Send v2.13 to Duncan', draft: null, sources: [source('L2', '2026-11-18', 'y')] }],
      done: [{ text: 'Catalogue v2.13 built', sources: [source('L2', '2026-11-18', 'y')] }] } };
}

function state(): InitiativesState {
  return { initiatives: [tesco(), { id: 'serco-eunify', title: 'EUnify users and data', client: 'serco', note: '01_Projects/serco/serco-eunify.md', at: null, summary: null,
    error: 'Provider first HTTP 503', error_at: '2026-11-18T07:01:00.000000Z' }], today: '2026-11-18', views: {}, requested: false, refreshing: false, providers: true };
}

test('cards show each initiative state; the detail draws who owes what, the board and the sources', async () => {
  render(<InitiativesPage {...props()} />);
  const cards = screen.getAllByRole('button', { pressed: true });
  expect(cards).toHaveLength(1);
  expect(cards[0]!.textContent).toContain('Waiting on them · 6d');
  const detail = screen.getByRole('region', { name: 'tesco OCP IAM' });
  expect(within(detail).getByRole('img').getAttribute('aria-label')).toBe('Open requests: Mohamed 1, Duncan 1');
  expect(detail.querySelector('[data-person="Mohamed"]')?.getAttribute('data-tone')).toBe('overdue');
  expect(detail.querySelector('[data-person="Duncan"]')?.getAttribute('data-tone')).toBe('you');
  expect(within(detail).getByRole('region', { name: 'Them (1)' }).textContent).toContain('6 working days');
  expect(within(detail).getByRole('region', { name: 'You (1)' }).textContent).toContain('Send v2.13 to Duncan');
  expect(detail.textContent).toContain('1 items dropped for citing no source');
  await userEvent.click(within(within(detail).getByRole('list')).getByRole('button', { name: 'Sources (1)' }));
  expect(within(detail).getByRole('note').textContent).toContain('Liubomir: standard pending');
  await userEvent.click(within(within(detail).getByRole('region', { name: 'AI (1)' })).getByRole('button', { name: 'Draft' }));
  expect(detail.textContent).toContain('Hi Mohamed, any news on 1-4?');
});

test('a failed initiative says so, the open is counted once a day, and Refresh asks the daemon', async () => {
  render(<InitiativesPage {...props()} />);
  await userEvent.click(screen.getByRole('button', { name: /EUnify users and data/ }));
  const detail = screen.getByRole('region', { name: 'serco EUnify users and data' });
  expect(within(detail).getByRole('alert').textContent).toContain('HTTP 503');
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/initiatives/seen', expect.objectContaining({ method: 'POST' })));
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/initiatives/refresh', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-everflow-token': ACTION }) })));
  cleanup();
  render(<InitiativesPage {...props()} />);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/initiatives/seen')).toHaveLength(1);
});
