// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CLIENT_CHAT_KEY, ClientChat } from '../../src/components/initiatives/client-chat.tsx';
import { InitiativesPage } from '../../src/components/initiatives/initiatives-page.tsx';
import type { InitiativesState, InitiativeView, OverviewState } from '../../src/lib/web-types.ts';
import { card, uiState } from './fixtures.ts';

const ORIGIN = 'https://chat.everflow.example.invalid';
const ACTION = 'a'.repeat(64);
let fetcher: ReturnType<typeof vi.fn>;
let running = false;
beforeEach(() => {
  running = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const client = /^\/api\/client-chat\/([^/]+)\//.exec(url)?.[1];
    if (client && url.endsWith('/open')) return Response.json({ client, day: '2026-11-23', session_id: `ses_${client}`, directory: `/home/aptul/everflow-chats/${client}` });
    if (client && url.endsWith('/status')) return Response.json({ client, day: '2026-11-23', session_id: running ? `ses_${client}` : null, running });
    if (init?.method === 'POST') return Response.json({ ticket: 106 });
    if (url.startsWith('/api/guide/')) return new Response('{}', { status: 404 });
    return url.startsWith('/api/state') ? new Response(null, { status: 304 }) : Response.json(initiatives());
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function view(id: string, client: string, title: string): InitiativeView {
  return { id, title, client, note: `01_Projects/${id}.md`, at: null, summary: null, error: null, error_at: null, waits: [] };
}
function initiatives(): InitiativesState {
  return { initiatives: [view('acme-access', 'acme', 'Access'), view('acme-cost', 'acme', 'Cost'), view('beta-move', 'beta', 'Move')], today: '2026-11-23', views: {},
    requested: false, refreshing: false, providers: true };
}
function board(origin: string | null): OverviewState {
  const base = uiState();
  const empty = { needs_you: [], failed: [], working: [], waiting_them: [], done_today: [], skipped: [] };
  const why = { text: 'Night usage shows the pool idle', sources: [{ id: 'L2', kind: 'log' as const, date: '2026-11-20', text: '2026-11-20 - Usage report' }, { id: 'S3', kind: 'section' as const, text: 'cost plan' }] };
  return { ...base, ...(origin ? { chat_origin: origin } : {}), initiatives: {
    'acme-access': { ...empty, needs_you: [card(108, { title: 'Cut one node', client: 'acme', origin: 'ai', why })],
      skipped: [card(106, { title: 'Old idea', client: 'acme', lifecycle: 'dismissed', stage: 'Dismissed', closed_at: '2026-11-22T09:00:00Z', dismissed_by: 'overview_chat', restorable: true }),
        card(107, { title: 'Page dismissed', client: 'acme', lifecycle: 'dismissed', stage: 'Dismissed', closed_at: '2026-11-22T09:00:00Z' })] },
    'acme-cost': empty, 'beta-move': empty } };
}
const page = (origin: string | null = ORIGIN) => render(<InitiativesPage initialState={initiatives()} initialBoard={board(origin)} initialEtag='"x"' token={ACTION} initialNow={Date.parse('2026-11-23T09:00:00Z')} />);

test('without a chat origin there is no bubble', () => {
  page(null);
  expect(screen.queryByRole('button', { name: /^Apri la chat di/ })).toBeNull();
  cleanup();
  render(<ClientChat client="acme" origin={undefined} token={ACTION} />);
  expect(screen.queryByRole('button', { name: /chat di/ })).toBeNull();
});

test('the bubble of the selected initiative\'s client opens a non-modal panel with the chat of the day; minimized, the page stays and the state is kept', async () => {
  page();
  const bubble = await screen.findByRole('button', { name: 'Apri la chat di acme' });
  expect(bubble.querySelector('path')!.getAttribute('d')).toBe('M12 3.5l1.9 4.9 4.9 1.9-4.9 1.9-1.9 4.9-1.9-4.9-4.9-1.9 4.9-1.9z');
  expect(bubble.closest('[data-client-chat]')!.textContent).toContain('acme');
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/client-chat/acme/status', expect.objectContaining({ method: 'POST', body: '{}',
    headers: expect.objectContaining({ 'x-everflow-token': ACTION }) })));
  expect(fetcher).not.toHaveBeenCalledWith('/api/client-chat/acme/open', expect.anything());
  await userEvent.click(bubble);
  const panel = await screen.findByRole('dialog', { name: 'Chat di acme' });
  expect(panel.getAttribute('aria-modal')).toBe('false');
  const frame = await within(panel).findByTitle('Chat di acme');
  expect(frame.getAttribute('src')).toBe(`${ORIGIN}/mini-chat.html?mode=session&sessionId=ses_acme&directory=%2Fhome%2Faptul%2Feverflow-chats%2Facme`);
  expect(within(panel).getByText('chat di oggi · 23/11')).toBeTruthy();
  expect(within(panel).getByRole('link', { name: 'Apri la chat di acme in OpenChamber' }).getAttribute('href')).toBe(`${ORIGIN}/?session=ses_acme`);
  expect(JSON.parse(window.localStorage.getItem(CLIENT_CHAT_KEY)!)).toMatchObject({ open: true });
  // the page stays usable under it
  expect(screen.getByRole('region', { name: 'acme Access' })).toBeTruthy();
  await userEvent.click(within(panel).getByRole('button', { name: 'Riduci la chat' }));
  expect(screen.queryByRole('dialog', { name: 'Chat di acme' })).toBeNull();
  expect(JSON.parse(window.localStorage.getItem(CLIENT_CHAT_KEY)!)).toMatchObject({ open: false });
  // another initiative of the same client keeps the same chat; another client switches it
  await userEvent.click(screen.getByRole('button', { pressed: false, name: /Cost/ }));
  expect(screen.getByRole('button', { name: 'Apri la chat di acme' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { pressed: false, name: /Move/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Apri la chat di beta' }));
  expect((await within(await screen.findByRole('dialog', { name: 'Chat di beta' })).findByTitle('Chat di beta')).getAttribute('src')).toContain('sessionId=ses_beta');
  expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/client-chat/acme/open')).toHaveLength(1);
});

test('a panel left open opens again on the next page, and a dot shows while the chat runs', async () => {
  running = true;
  window.localStorage.setItem(CLIENT_CHAT_KEY, JSON.stringify({ x: 40, y: 60, open: true }));
  render(<ClientChat client="acme" origin={ORIGIN} token={ACTION} />);
  expect(await screen.findByRole('dialog', { name: 'Chat di acme' })).toBeTruthy();
  const bubble = screen.getByRole('button', { name: 'Riduci la chat di acme' });
  expect(bubble.closest<HTMLElement>('[data-client-chat]')!.style.left).toBe('40px');
  expect(await within(bubble).findByLabelText('La chat sta lavorando')).toBeTruthy();
});

test('an AI card says Perché with its sources; a chat dismissal shows dalla chat and Ripristina, a page dismissal neither', async () => {
  page();
  const detail = screen.getByRole('region', { name: 'acme Access' });
  const ai = within(detail).getByRole('article', { name: 'Ticket #108: Cut one node' });
  expect(within(ai).getByText('Perché')).toBeTruthy();
  expect(ai.textContent).toContain('Night usage shows the pool idle');
  expect(within(ai).getByRole('list', { name: 'Sources' }).textContent).toBe('L2 · 20/11S3 · cost plan');
  await userEvent.click(within(ai).getByRole('button', { name: 'Expand ticket #108' }));
  const expanded = screen.getByRole('dialog');
  expect(within(expanded).getByText('Why')).toBeTruthy();
  expect(within(expanded).getByRole('list', { name: 'Sources' })).toBeTruthy();
  await userEvent.keyboard('{Escape}');
  const chat = within(detail).getByRole('article', { name: 'Ticket #106: Old idea' });
  expect(within(chat).getByText('dalla chat')).toBeTruthy();
  const plain = within(detail).getByRole('article', { name: 'Ticket #107: Page dismissed' });
  expect(within(plain).queryByText('dalla chat')).toBeNull();
  expect(within(plain).queryByRole('button', { name: /Ripristina/ })).toBeNull();
  await userEvent.click(within(chat).getByRole('button', { name: 'Ripristina ticket #106' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/ticket/106/restore', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-everflow-token': ACTION }) })));
});
