// @vitest-environment jsdom
import { utils as workbook, write as writeWorkbook } from 'xlsx';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TicketBoard } from '../../src/components/tickets/ticket-board.tsx';
import { muteMinutes } from '../../src/components/tickets/action-dialog.tsx';
import { AT, card, uiDetail, uiState } from './fixtures.ts';
import { DatabaseSync } from 'node:sqlite';
import { webFixture } from '../web-fixture.ts';
import { readState, representation, ticketDetail } from '../../src/web/state.ts';

let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ ticket: 1 }) : new Response(null, { status: 304 }));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

function board(state = uiState()) { return render(<TicketBoard initialState={state} initialEtag={'"initial"'} token="per-start-token" />); }
function ticket(id = 1, title = 'Reset access') { return screen.getByRole('article', { name: `Ticket #${id}: ${title}` }); }

test('a long column shows eight cards, then more on demand and back to eight', async () => {
  const state = uiState();
  for (let id = 100; id < 111; id++) state.groups.done_today.push(card(id, { title: `Closed ${id}`, lifecycle: 'done', stage: 'Done', closed_at: AT }));
  board(state);
  const column = screen.getByRole('region', { name: 'Done (12)' });
  expect(within(column).getAllByRole('article')).toHaveLength(8);
  await userEvent.click(within(column).getByRole('button', { name: 'Show 4 more in Done' }));
  expect(within(column).getAllByRole('article')).toHaveLength(12);
  expect(within(column).queryByRole('button', { name: /more in Done/ })).toBeNull();
  await userEvent.click(within(column).getByRole('button', { name: 'Show less in Done' }));
  expect(within(column).getAllByRole('article')).toHaveLength(8);
  expect(within(screen.getByRole('region', { name: 'Needs you (2)' })).queryByRole('button', { name: /^Show/ })).toBeNull();
});

test('a healthy Google Chat source shows no coverage warning: recent-topic reads are its normal state', () => {
  const state = uiState();
  state.health.push(Object.assign({ dependency: 'gchat', scope: 'source' as const, state: 'ok' as const, since: null, last_ok: null, last_error: null }, { coverage: 'recent-topics' as const, observed_at: '2026-11-07T10:00:00Z' }));
  board(state);
  expect(screen.getByRole('region', { name: 'Health' }).textContent).not.toMatch(/Recent topics|Observed/);
});

test('a triage account checked through Meridian shows its 5-hour and 7-day usage', () => {
  const state = uiState();
  state.health = state.health.filter((item) => item.dependency !== 'provider:first');
  state.health.push(Object.assign({ dependency: 'provider:first', scope: 'provider' as const, state: 'ok' as const, since: null, last_ok: null, last_error: null },
    { usage: { five_hour: 0.464, seven_day: 0.16 } }));
  board(state);
  expect(screen.getByRole('region', { name: 'Health' }).textContent).toContain('5h 46% · 7d 16%');
});

test('switched-off sources and accounts fold away and unused dependencies say so', () => {
  const state = uiState();
  const at = '2026-11-06T06:00:00.000000Z';
  state.health.push(
    { dependency: 'outlook', scope: 'source', state: 'disabled', since: null, last_ok: null, last_error: null },
    { dependency: 'teamsrelay', scope: 'source', state: 'ok', since: at, last_ok: at, last_error: null },
    { dependency: 'teamsrelay:on@example.invalid', scope: 'account', state: 'ok', since: at, last_ok: at, last_error: null },
    { dependency: 'teamsrelay:off@example.invalid', scope: 'account', state: 'disabled', since: null, last_ok: null, last_error: null },
  );
  board(state);
  const health = screen.getByRole('region', { name: 'Health' });
  expect(within(health).queryByRole('heading', { name: 'outlook' })).toBeNull();
  expect(within(health).getByText('Off: outlook')).toBeTruthy();
  const relay = health.querySelector('[data-node="input-1"]')!;
  expect(within(relay as HTMLElement).getByRole('heading', { name: 'teamsrelay' })).toBeTruthy();
  expect(relay.textContent).toContain('ok');
  const off = within(relay as HTMLElement).getByText('1 account off').closest('details')!;
  expect(off.open).toBe(false);
  expect(off.textContent).toContain('off@example.invalid');
  expect(health.querySelector('[data-node="openchamber"]')!.textContent).toContain('not used yet');
  expect(health.querySelector('[data-node="openchamber"]')!.textContent).not.toContain('unknown');
});

test('an unused fallback provider does not grey out a working triage stage', () => {
  const state = uiState();
  const at = '2026-11-06T06:00:00.000000Z';
  state.health.push(
    { dependency: 'provider:first', scope: 'provider', state: 'ok', since: at, last_ok: at, last_error: null },
    { dependency: 'provider:fallback', scope: 'provider', state: 'unknown', since: null, last_ok: null, last_error: null },
  );
  board(state);
  const triage = screen.getByRole('region', { name: 'Health' }).querySelector('[data-node="triage"]')!;
  expect(triage.querySelector('h3')!.parentElement!.textContent).toContain('ok');
  expect(triage.querySelector('h3')!.parentElement!.textContent).not.toContain('not used yet');
});

test('a proposed ticket shows Start and Discuss labelled, with Done and Dismiss on a second row of the same grid', () => {
  board();
  const start = within(ticket()).getByRole('button', { name: 'Start' });
  const discuss = within(ticket()).getByRole('button', { name: 'Discuss' });
  expect(discuss.textContent).toBe('Discuss');
  expect(discuss.getAttribute('data-shortcut')).toBe('c');
  const grid = start.parentElement!;
  expect(grid.className).toMatch(/\bgrid\b.*\bgrid-cols-2\b/);
  expect([...grid.children].map((node) => node.textContent)).toEqual(['Start', 'Discuss', 'Done', 'Dismiss']);
  expect(within(ticket()).queryByRole('button', { name: 'Open chat with note' })).toBeNull();
  const active = screen.getByRole('article', { name: 'Ticket #3: Active work' });
  expect(within(active).queryByRole('button', { name: 'Discuss' })).toBeNull();
  expect(within(active).getByRole('button', { name: 'Mark done' }).parentElement!.className).toMatch(/\bgrid-cols-2\b/);
  const make = screen.getByRole('button', { name: 'Make ticket from batch #10' });
  expect(make.parentElement!.className).toContain('@container');
  expect(within(make).getByText('Make ticket').className).toMatch(/\bhidden\b.*@\[13rem\]:inline/);
  expect(within(make).getByText('Ticket').className).toMatch(/\bhidden\b.*@\[10\.5rem\]:inline.*@\[13rem\]:hidden/);
  expect(within(ticket()).getByRole('button', { name: 'Timeline' }).parentElement!.className).toContain('flex-wrap');
});

test('board columns keep equal widths, empty or not, and long titles never widen them', () => {
  const state = uiState();
  state.groups.failed = [];
  const long = 'davide-antonio.mancini@ivecogroup.com, Lusine, paolo.cappellino@ivecogroup.com, massimo.mongiardino@external.ivecogroup.com, +7';
  state.skipped[0]!.title = long;
  board(state);
  const full = screen.getByRole('region', { name: /^Needs you/ }), empty = screen.getByRole('region', { name: /^Failed/ });
  expect(full.className).toContain('xl:min-w-0');
  const title = screen.getByRole('heading', { name: `Batch #10: ${long}` });
  expect(title.className).toContain('line-clamp-3');
  expect(title.getAttribute('title')).toBe(long);
  expect(full.parentElement!.className).toContain('xl:grid-cols-6');
  expect(full.className).not.toContain('xl:flex-1');
  expect(empty.className).not.toContain('xl:w-40');
});

test('the board card shows only the title and a two-line description; ask, proposal and notes live in the popup', () => {
  board();
  const first = ticket();
  expect(within(first).getByText('Source summary').className).toContain('line-clamp-2');
  for (const hidden of ['Confirm access scope', 'Check membership first', '01_Projects/access.md', 'OPS-123']) expect(within(first).queryByText(hidden)).toBeNull();
  const active = screen.getByRole('article', { name: 'Ticket #3: Active work' });
  expect(within(active).getByText('Membership checked').className).toContain('line-clamp-2');
  expect(within(active).queryByText('North access investigation')).toBeNull();
});

test('the popup renders light Markdown from the AI fields safely, and the close button is centered', async () => {
  const state = uiState();
  Object.assign(state.groups.needs_you[0]!, {
    summary: 'Giovanni wants **SNAM UAT** updated by `16:00`.',
    proposal: '1. Check **dmm-ui** 1.34\n2. Install on *pre-prod*\n3. Read [the guide](https://example.invalid/guide) and [bad](javascript:alert(1))',
    reason: 'Path 01_Projects/dmm_onprem.md stays literal. <img src=x onerror=bad()>\n\n- first point\n- second point',
  });
  board(state);
  expect(within(ticket()).getByText('SNAM UAT').tagName).toBe('STRONG');
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Expand ticket #1' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reset access' });
  expect(within(dialog).getByText('SNAM UAT').tagName).toBe('STRONG');
  expect(within(dialog).getByText('16:00').tagName).toBe('CODE');
  const steps = within(dialog).getByText('dmm-ui').closest('ol')!;
  expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
  expect(within(dialog).getByText('pre-prod').tagName).toBe('EM');
  expect(within(dialog).getByRole('link', { name: 'the guide' }).getAttribute('href')).toBe('https://example.invalid/guide');
  expect(within(dialog).queryByRole('link', { name: 'bad' })).toBeNull();
  expect(dialog.textContent).toContain('01_Projects/dmm_onprem.md');
  expect(dialog.textContent).toContain('<img src=x onerror=bad()>');
  expect(dialog.querySelector('img')).toBeNull();
  expect(within(dialog).getByText('second point').closest('ul')).not.toBeNull();
  expect(dialog.textContent).not.toContain('**');
  const close = within(dialog).getByRole('button', { name: 'Close' });
  expect(close.className).toMatch(/\binline-flex\b.*\bitems-center\b.*\bjustify-center\b/);
  expect(close.className).toContain('focus-visible:ring-2');
  expect(close.className).not.toMatch(/(^|\s)focus:ring-2/);
});

test('a healthy pipeline folds into one status line with the problem count, and opens itself when something fails', () => {
  const state = uiState();
  const at = '2026-11-06T06:00:00.000000Z';
  state.health = [{ dependency: 'daemon', scope: 'daemon', state: 'ok', since: at, last_ok: at, last_error: null }];
  state.problems = { jobs: [], quarantine: [], triage: [] };
  board(state);
  const health = screen.getByRole('region', { name: 'Health' });
  expect(health.querySelector('#pipeline-diagram')).toBeNull();
  expect(health.textContent).toContain('No problems');
  expect(screen.queryByRole('region', { name: 'Problems' })).toBeNull();
  expect(within(health).getByRole('button', { name: /Show/ }).getAttribute('aria-expanded')).toBe('false');
  cleanup();
  board();
  expect(screen.getByRole('region', { name: 'Health' }).querySelector('#pipeline-diagram')).not.toBeNull();
  expect(screen.getByRole('region', { name: 'Problems' })).toBeTruthy();
});

test('cards are flat with a status stripe in the column color', () => {
  board();
  const stripe = (card: HTMLElement) => card.querySelector('[data-stripe]')!.className;
  expect(ticket().className).not.toContain('shadow-xs');
  expect(stripe(ticket())).toContain('bg-primary');
  expect(stripe(screen.getByRole('article', { name: 'Ticket #5: Failed work' }))).toContain('bg-destructive');
  expect(stripe(screen.getByRole('heading', { name: 'Batch #10: Skipped source' }).closest<HTMLElement>('[data-batch-id]')!)).toContain('bg-input');
});

test('a closed ticket card keeps its sum-up instead of the close reason', () => {
  const state = uiState();
  Object.assign(state.groups.done_today[0]!, { summary: 'Install request from Giovanni', report_line: 'Closed manually' });
  board(state);
  const done = screen.getByRole('article', { name: 'Ticket #7: Closed work' });
  expect(within(done).getByText('Install request from Giovanni')).toBeTruthy();
  expect(within(done).queryByText('Closed manually')).toBeNull();
});

test('Expand opens a popup with the full ticket, its reasoning, messages and timeline', async () => {
  board();
  const first = ticket();
  expect(within(first).getByText('Source summary').className).toContain('line-clamp-2');
  expect(within(first).queryByText('Same issue as the open access request')).toBeNull();
  expect(within(first).queryByRole('button', { name: 'Show more' })).toBeNull();
  await userEvent.click(within(first).getByRole('button', { name: 'Expand ticket #1' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reset access' });
  expect(within(dialog).getByText('Source summary').className).not.toContain('line-clamp');
  expect(within(dialog).getByText('Confirm access scope').className).not.toContain('line-clamp');
  expect(within(dialog).getByText('Why').closest('div')!.textContent).toContain('Same issue as the open access request');
  expect(within(dialog).getByText('01_Projects/access.md').className).toContain('break-all');
  expect(within(dialog).getByText('Newest source message')).toBeTruthy();
  expect(within(dialog).getByRole('heading', { name: 'Timeline' })).toBeTruthy();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  ticket().focus();
  await userEvent.keyboard('e');
  expect(await screen.findByRole('dialog', { name: 'Reset access' })).toBeTruthy();
});

test('skipped batches clear one by one or selected in bulk', async () => {
  board();
  await userEvent.click(screen.getByRole('button', { name: 'Clear batch #10' }));
  expect(fetcher).toHaveBeenCalledWith('/api/batch/10/clear', expect.objectContaining({ method: 'POST', body: '{}' }));
  expect(screen.queryByRole('button', { name: /^Clear selected/ })).toBeNull();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select batch #11' }));
  expect(screen.getByRole('button', { name: 'Clear selected (1)' })).toBeTruthy();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select all skipped' }));
  await userEvent.click(screen.getByRole('button', { name: 'Clear selected (4)' }));
  for (const id of [10, 11, 12]) expect(fetcher).toHaveBeenCalledWith(`/api/batch/${id}/clear`, expect.objectContaining({ method: 'POST' }));
  expect(fetcher).toHaveBeenCalledWith('/api/ticket/6/clear', expect.objectContaining({ method: 'POST' }));
});

test('a dismissed or done ticket clears from the board on its own or with the skipped selection', async () => {
  board();
  const dismissed = screen.getByRole('article', { name: 'Ticket #6: Dismissed work' });
  expect(within(dismissed).getByRole('checkbox', { name: 'Select ticket #6' })).toBeTruthy();
  await userEvent.click(within(dismissed).getByRole('button', { name: 'Clear ticket #6' }));
  expect(fetcher).toHaveBeenCalledWith('/api/ticket/6/clear', expect.objectContaining({ method: 'POST', body: '{}' }));
  const done = screen.getByRole('article', { name: 'Ticket #7: Closed work' });
  await userEvent.click(within(done).getByRole('button', { name: 'Clear ticket #7' }));
  expect(fetcher).toHaveBeenCalledWith('/api/ticket/7/clear', expect.objectContaining({ method: 'POST' }));
  await userEvent.click(within(dismissed).getByRole('checkbox', { name: 'Select ticket #6' }));
  expect(screen.getByRole('button', { name: 'Clear selected (1)' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Dismiss selected (0)' })).toBeTruthy();
  expect(within(ticket()).queryByRole('button', { name: /^Clear ticket/ })).toBeNull();
});

test('a ticket with a chat says where the chat is, from the moment it opens', () => {
  const state = uiState();
  state.groups.working[0]!.session_id = 'ses_synthetic123';
  state.groups.working[0]!.session_title = null;
  board(state);
  const card = screen.getByRole('article', { name: 'Ticket #3: Active work' });
  const chat = within(card).getByText('Chat open in OpenChamber, project Vault');
  expect(chat.closest('[title]')!.getAttribute('title')).toBe('Session ses_synthetic123');
  expect(within(ticket()).queryByText(/Chat open in OpenChamber/)).toBeNull();
  const open = within(card).getByRole('link', { name: 'Open the chat of ticket #3 in OpenChamber' });
  expect(open.getAttribute('href')).toBe('openchamber://session/ses_synthetic123');
  expect(open.textContent).toBe('Open');
  expect(within(ticket()).queryByRole('link', { name: /in OpenChamber/ })).toBeNull();
  expect(within(card).queryByRole('link', { name: /OpenChamber web/ })).toBeNull();
});

test('an approved chat queued over a minute shows Chat not started with Start now, which posts start-now', async () => {
  fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' && String(input) === '/api/ticket/3/start-now'
    ? Response.json({ ticket: 3 }) : new Response(null, { status: 304 }));
  const state = uiState();
  Object.assign(state.groups.working[0]!, { chat_waiting_since: new Date(Date.now() - 5 * 60_000).toISOString() });
  board(state);
  const card = screen.getByRole('article', { name: 'Ticket #3: Active work' });
  expect(within(card).getByText(/^Chat not started, queued /)).toBeTruthy();
  await userEvent.click(within(card).getByRole('button', { name: 'Start the chat of ticket #3 now' }));
  expect(fetcher).toHaveBeenCalledWith('/api/ticket/3/start-now', expect.objectContaining({ method: 'POST' }));
});

test('an approved chat queued under a minute shows no Start now', () => {
  const state = uiState();
  Object.assign(state.groups.working[0]!, { chat_waiting_since: new Date(Date.now() - 10_000).toISOString() });
  board(state);
  const card = screen.getByRole('article', { name: 'Ticket #3: Active work' });
  expect(within(card).queryByRole('button', { name: 'Start the chat of ticket #3 now' })).toBeNull();
});

test('with a chat origin Open shows the chat on the board: the chat view framed with the folder the server resolved', async () => {
  fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' && String(input) === '/api/ticket/3/open-chat'
    ? Response.json({ ticket: 3, session_id: 'ses_synthetic123', directory: '/home/aptul/Vault' }) : new Response(null, { status: 304 }));
  const state = uiState();
  Object.assign(state.groups.working[0]!, { session_id: 'ses_synthetic123', chat_running: true });
  state.chat_origin = 'https://chat.everflow.example.invalid';
  board(state);
  const card = screen.getByRole('article', { name: 'Ticket #3: Active work' });
  expect(within(card).getByText('Chat working now, project Vault')).toBeTruthy();
  expect(within(card).queryByRole('link')).toBeNull();
  const open = within(card).getByRole('button', { name: 'Open the chat of ticket #3' });
  expect(open.textContent).toBe('Open');
  await userEvent.click(open);
  const dialog = await screen.findByRole('dialog', { name: '#3Active work' });
  expect(fetcher).toHaveBeenCalledWith('/api/ticket/3/open-chat', expect.objectContaining({ method: 'POST', body: '{}',
    headers: expect.objectContaining({ 'x-everflow-token': 'per-start-token' }) }));
  const frame = await within(dialog).findByTitle('Chat of ticket #3');
  expect(frame.getAttribute('src')).toBe('https://chat.everflow.example.invalid/mini-chat.html?mode=session&sessionId=ses_synthetic123&directory=%2Fhome%2Faptul%2FVault');
  expect(frame.getAttribute('allow')).toBe('clipboard-read; clipboard-write; microphone');
  expect(screen.queryByText('Local action saved.')).toBeNull();
  expect(dialog.className).toMatch(/\bh-dvh\b.*\bw-screen\b/);
  expect(dialog.className).toMatch(/sm:h-\[calc\(100dvh-1\.5rem\)\].*sm:w-\[min\(1100px,96vw\)\]/);
  // the chat view's own header carries Close (the bridge); the dialog adds none while that view may still answer
  expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
  const web = within(dialog).getByRole('link', { name: 'Open the chat of ticket #3 in OpenChamber' });
  expect(web.getAttribute('href')).toBe('https://chat.everflow.example.invalid/?session=ses_synthetic123');
  expect(web.getAttribute('target')).toBe('_blank');
  expect(web.textContent).toBe('OpenChamber');
  expect(within(dialog).getByRole('link', { name: 'Open the chat of ticket #3 in the OpenChamber app' }).getAttribute('href')).toBe('openchamber://session/ses_synthetic123');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('the chat dialog says why a chat cannot open instead of showing an empty chat', async () => {
  fetcher.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ error: { code: 'chat.not-found', message: 'OpenChamber has no session ses_synthetic123' } }, { status: 404 }) : new Response(null, { status: 304 }));
  const state = uiState();
  state.groups.working[0]!.session_id = 'ses_synthetic123';
  state.chat_origin = 'https://chat.everflow.example.invalid';
  board(state);
  await userEvent.click(screen.getByRole('button', { name: 'Open the chat of ticket #3' }));
  const dialog = await screen.findByRole('dialog');
  expect((await within(dialog).findByRole('alert')).textContent).toBe('OpenChamber has no session ses_synthetic123');
  expect(dialog.querySelector('iframe')).toBeNull();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('with a chat origin the header opens OpenChamber web left of the search; without one the board is as before', () => {
  const state = uiState();
  state.groups.working[0]!.session_id = 'ses_synthetic123';
  state.chat_origin = 'https://chat.everflow.example.invalid';
  board(state);
  const link = screen.getByRole('link', { name: 'OpenChamber' });
  expect(link.getAttribute('href')).toBe('https://chat.everflow.example.invalid');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.compareDocumentPosition(screen.getByRole('searchbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  cleanup();
  const plain = uiState();
  plain.groups.working[0]!.session_id = 'ses_synthetic123';
  board(plain);
  expect(screen.queryByRole('link', { name: 'OpenChamber' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Open the chat/ })).toBeNull();
  expect(screen.getByRole('link', { name: 'Open the chat of ticket #3 in OpenChamber' }).getAttribute('href')).toBe('openchamber://session/ses_synthetic123');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('after Discuss the chat dialog opens as soon as the daemon has created the chat', async () => {
  const state = uiState();
  state.chat_origin = 'https://chat.everflow.example.invalid';
  const created = structuredClone(state);
  Object.assign(created.groups.needs_you.find((item) => item.id === 1)!, { session_id: 'ses_discussed1' });
  let polls = 0;
  fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return String(input) === '/api/ticket/1/open-chat'
      ? Response.json({ ticket: 1, session_id: 'ses_discussed1', directory: '/home/aptul/Vault' }) : Response.json({ ticket: 1 });
    // the first refresh still has no chat, the next one has it
    return ++polls < 2 ? new Response(null, { status: 304 }) : Response.json(created, { headers: { etag: '"created"' } });
  });
  board(state);
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Discuss' }));
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Open chat' }));
  const frame = await screen.findByTitle('Chat of ticket #1', {}, { timeout: 5_000 });
  expect(frame.getAttribute('src')).toContain('sessionId=ses_discussed1');
  expect(screen.getByRole('dialog', { name: '#1Reset access' })).toBeTruthy();
});

// The chat dialog's file viewer: a ticket chat that wrote a Markdown note and an Excel workbook
const MD = '/home/aptul/Vault/99_Inbox/prompt.md', XLSX = '/home/aptul/Vault/reports/audit.xlsx';
function chatWithFiles(files: () => unknown[], contents: Record<string, () => string | ArrayBuffer> = {}, named: Record<string, unknown> = {}) {
  const reads: string[] = [], infos: string[] = [];
  fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response(null, { status: 304 });
    const url = String(input);
    if (url === '/api/ticket/3/open-chat') return Response.json({ ticket: 3, session_id: 'ses_synthetic123', directory: '/home/aptul/Vault' });
    if (url === '/api/ticket/3/chat-files') return Response.json({ ticket: 3, files: files() });
    if (url === '/api/ticket/3/chat-file-info') {
      const { path } = JSON.parse(String(init.body)) as { path: string };
      infos.push(path);
      return named[path] ? Response.json({ ticket: 3, file: named[path] })
        : Response.json({ error: { code: 'file.not-listed', message: 'This chat has not named that file' } }, { status: 404 });
    }
    if (url === '/api/ticket/3/chat-file') {
      const { path } = JSON.parse(String(init.body)) as { path: string };
      reads.push(path);
      return new Response(contents[path]?.() ?? '', { headers: { 'content-type': path.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8' } });
    }
    return Response.json({ ticket: 3 });
  });
  const state = uiState();
  Object.assign(state.groups.working[0]!, { session_id: 'ses_synthetic123' });
  state.chat_origin = 'https://chat.everflow.example.invalid';
  return { state, reads, infos };
}
const file = (path: string, kind: string, touched: string, mtime = touched) => ({ path, name: path.split('/').at(-1), size: 120, mtime, kind, touched });

test('the chat dialog keeps its single column while the chat has written no files', async () => {
  const { state } = chatWithFiles(() => []);
  board(state);
  await userEvent.click(screen.getByRole('button', { name: 'Open the chat of ticket #3' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByTitle('Chat of ticket #3');
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/ticket/3/chat-files', expect.objectContaining({ method: 'POST', body: '{}' })));
  expect(dialog.className).toMatch(/sm:w-\[min\(1100px,96vw\)\]/);
  expect(within(dialog).queryByRole('region', { name: 'Files of this chat' })).toBeNull();
  expect(within(dialog).queryByRole('tablist')).toBeNull();
  expect(within(dialog).queryByRole('button', { name: /files of this chat/ })).toBeNull();
});

test('with files the panel starts closed; Files opens it: chat left, newest file right, Markdown rendered, Excel shown, tabs on a phone', async () => {
  localStorage.clear();
  const book = workbook.book_new();
  workbook.book_append_sheet(book, workbook.aoa_to_sheet([['Audit trail'], ['Ten years']]), 'Audit');
  workbook.book_append_sheet(book, workbook.aoa_to_sheet([['Other data']]), 'Details');
  const { state, reads } = chatWithFiles(() => [file(MD, 'markdown', '2026-11-17T16:45:00Z'), file(XLSX, 'workbook', '2026-11-17T15:00:00Z')], {
    [MD]: () => '---\ncreated: 2026-11-17\ntags: [type/prompt]\n---\n\n# Prompt\n\n- one\n- two\n\n| Field | Kept |\n|---|---|\n| IP | yes |\n\n```\ncode block\n```\n\n<script>alert(1)</script>',
    [XLSX]: () => writeWorkbook(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
  });
  board(state);
  await userEvent.click(screen.getByRole('button', { name: 'Open the chat of ticket #3' }));
  const dialog = await screen.findByRole('dialog');
  const viewer = await within(dialog).findByRole('region', { name: 'Files of this chat' });
  // closed at first: the single chat column, the file one click on Files away
  expect(dialog.className).toMatch(/sm:w-\[min\(1100px,96vw\)\]/);
  expect(viewer.parentElement!.className.split(' ')).toContain('sm:hidden');
  await userEvent.click(await within(dialog).findByRole('button', { name: 'Show the files of this chat (2)' }));
  expect(dialog.className).toMatch(/sm:w-\[min\(1800px,98vw\)\]/);
  expect(viewer.parentElement!.className.split(' ')).not.toContain('sm:hidden');
  // the chat column comes first, and the links and Close sit over it, not over the viewer
  const frame = await within(dialog).findByTitle('Chat of ticket #3');
  expect(frame.compareDocumentPosition(viewer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(frame.parentElement!.className).toMatch(/sm:w-\[min\(800px,55%\)\]/);
  const links = within(dialog).getByRole('link', { name: 'Open the chat of ticket #3 in OpenChamber' }).parentElement!.parentElement!;
  expect(links.className).toContain('sm:w-[min(800px,55%)]');
  expect(links.className).toContain('sm:pr-[176px]');
  expect(viewer.contains(links)).toBe(false);

  // the newest file opens as the first tab; the file list opens the others, each in its own tab
  const open = within(viewer).getByRole('tablist', { name: 'Open files' });
  expect(within(open).getAllByRole('tab').map((tab) => [tab.textContent, tab.title, tab.getAttribute('aria-selected')])).toEqual([['prompt.md', MD, 'true']]);
  expect(within(viewer).queryByRole('combobox')).toBeNull();
  expect((await within(viewer).findByRole('heading', { name: 'Prompt' })).tagName).toBe('H1');
  // front matter shows as a block of its own, never as a heading
  expect(within(viewer).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Prompt']);
  expect(within(viewer).getByLabelText('Front matter').textContent).toBe('created: 2026-11-17\ntags: [type/prompt]');
  expect(within(viewer).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['one', 'two']);
  expect(within(viewer).getByRole('table').textContent).toContain('IPyes');
  expect(within(viewer).getByText('code block').tagName).toBe('CODE');
  expect(viewer.querySelector('script')).toBeNull();
  expect(reads).toEqual([MD]);

  await userEvent.click(within(viewer).getByRole('button', { name: 'Toggle file tree' }));
  const list = within(viewer).getByRole('navigation', { name: 'File list' });
  expect(within(list).getAllByRole('button').map((entry) => [entry.title, entry.getAttribute('aria-current')])).toEqual([[MD, 'true'], [XLSX, null]]);
  expect(within(list).getAllByRole('button')[0]!.textContent).toMatch(/^prompt\.md\d+[mhd]$/);
  await userEvent.click(within(list).getByTitle(XLSX));
  expect(within(open).getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['prompt.md', 'false'], ['audit.xlsx', 'true']]);
  expect((await within(viewer).findByRole('table', { name: 'Audit' })).textContent).toContain('Audit trail');
  expect(within(viewer).getByText('Ten years')).toBeTruthy();
  await userEvent.selectOptions(within(viewer).getByLabelText('Worksheet'), '1');
  expect(within(viewer).getByRole('table', { name: 'Details' }).textContent).toBe('Other data');
  expect(within(viewer).getByRole('button', { name: 'Download audit.xlsx' })).toBeTruthy();
  expect(within(viewer).getByRole('button', { name: 'Reload the file' })).toBeTruthy();

  // phone: two tabs, the chat first, the file one tap away; the chat frame stays loaded
  const tabs = within(dialog).getByRole('tablist', { name: 'Chat or file' });
  expect(tabs.className).toContain('sm:hidden');
  const [chatTab, fileTab] = within(tabs).getAllByRole('tab');
  expect([chatTab!.textContent, chatTab!.getAttribute('aria-selected'), fileTab!.textContent]).toEqual(['Chat', 'true', 'File']);
  expect(viewer.parentElement!.className).toContain('max-sm:hidden');
  await userEvent.click(fileTab!);
  expect(fileTab!.getAttribute('aria-selected')).toBe('true');
  expect(viewer.parentElement!.className).not.toContain('max-sm:hidden');
  expect(frame.parentElement!.className).toContain('max-sm:hidden');
  expect(within(dialog).getByTitle('Chat of ticket #3')).toBe(frame);

  // desktop: hiding the panel brings back the single column; the dialog opens with it closed every time
  await userEvent.click(within(dialog).getByRole('button', { name: 'Hide the files of this chat' }));
  expect(dialog.className).toMatch(/sm:w-\[min\(1100px,96vw\)\]/);
  expect(viewer.parentElement!.className).toContain('sm:hidden');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Show the files of this chat (2)' }));
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Open the chat of ticket #3' }));
  const again = await screen.findByRole('dialog');
  const show = await within(again).findByRole('button', { name: 'Show the files of this chat (2)' });
  expect(again.className).toMatch(/sm:w-\[min\(1100px,96vw\)\]/);
  await userEvent.click(show);
  expect(again.className).toMatch(/sm:w-\[min\(1800px,98vw\)\]/);
});

test('the viewer asks for the file list every 10 seconds and reloads the open file when it changed on disk', async () => {
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let mtime = '2026-11-17T16:45:00Z', version = 1;
  const { state, reads } = chatWithFiles(() => [file(MD, 'markdown', '2026-11-17T16:45:00Z', mtime)], { [MD]: () => `# Version ${version}` });
  board(state);
  await userEvent.click(screen.getByRole('button', { name: 'Open the chat of ticket #3' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('heading', { name: 'Version 1' });
  const lists = () => fetcher.mock.calls.filter(([url]) => String(url) === '/api/ticket/3/chat-files').length;
  const before = lists();
  // unchanged: listed again, not read again
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  await waitFor(() => expect(lists()).toBe(before + 1));
  expect(reads).toHaveLength(1);
  mtime = '2026-11-17T16:50:00Z'; version = 2;
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(await within(dialog).findByRole('heading', { name: 'Version 2' })).toBeTruthy();
  expect(reads).toEqual([MD, MD]);
});

// The chat view's bridge (src/web/everflow-bridge.js) posts from the framed chat host
const CHAT = 'https://chat.everflow.example.invalid', PLAN = '/home/aptul/Vault/notes/plan.md';
function fromChat(frame: HTMLElement, data: unknown, origin = CHAT, source: MessageEventSource | null = (frame as HTMLIFrameElement).contentWindow) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { origin, source, data })); });
}

test('files clicked in the chat open as tabs: A, then B the chat only read (asked from the server), then A again focuses its tab', async () => {
  localStorage.clear();
  const { state, reads, infos } = chatWithFiles(() => [file(MD, 'markdown', '2026-11-17T16:45:00Z')], { [MD]: () => '# Prompt', [PLAN]: () => '# Plan\n\nStep 1' },
    { 'notes/plan.md': file(PLAN, 'markdown', '2026-11-17T16:00:00Z') });
  board(state);
  await userEvent.click(screen.getByRole('button', { name: 'Open the chat of ticket #3' }));
  const dialog = await screen.findByRole('dialog');
  const frame = await within(dialog).findByTitle('Chat of ticket #3');
  const viewer = await within(dialog).findByRole('region', { name: 'Files of this chat' });
  await within(viewer).findByRole('heading', { name: 'Prompt' });
  const tabs = () => within(within(viewer).getByRole('tablist', { name: 'Open files' })).getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]);

  // A: already open under the same path, focused without asking the server
  fromChat(frame, { type: 'everflow:open-file', path: MD });
  expect(tabs()).toEqual([['prompt.md', 'true']]);
  // B: a relative path from a tool row, which only the server can resolve against the session folder
  fromChat(frame, { type: 'everflow:open-file', path: 'notes/plan.md' });
  await waitFor(() => expect(tabs()).toEqual([['prompt.md', 'false'], ['plan.md', 'true']]));
  expect(await within(viewer).findByRole('heading', { name: 'Plan' })).toBeTruthy();
  expect(infos).toEqual(['notes/plan.md']);
  // A again: its tab, no third one
  fromChat(frame, { type: 'everflow:open-file', path: MD });
  expect(tabs()).toEqual([['prompt.md', 'true'], ['plan.md', 'false']]);
  expect(await within(viewer).findByRole('heading', { name: 'Prompt' })).toBeTruthy();
  expect(reads).toEqual([MD, PLAN, MD]);

  // another origin, another window, a malformed message: nothing happens
  fromChat(frame, { type: 'everflow:open-file', path: '/etc/passwd' }, 'https://evil.example.invalid');
  fromChat(frame, { type: 'everflow:open-file', path: '/etc/passwd' }, CHAT, window);
  fromChat(frame, { type: 'everflow:open-file', path: 42 });
  fromChat(frame, { type: 'everflow:close' }, 'https://evil.example.invalid');
  expect(infos).toEqual(['notes/plan.md']);
  expect(screen.getByRole('dialog')).toBeTruthy();

  // a file the chat never named: said in the panel, no tab
  fromChat(frame, { type: 'everflow:open-file', path: '/home/aptul/secret.md' });
  expect((await within(viewer).findByRole('alert')).textContent).toBe('/home/aptul/secret.md: This chat has not named that file');
  expect(tabs()).toHaveLength(2);

  // a tab closes on its own; the view's Close closes the dialog
  await userEvent.click(within(viewer).getByRole('button', { name: 'Close plan.md' }));
  expect(tabs()).toEqual([['prompt.md', 'true']]);
  fromChat(frame, { type: 'everflow:close' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('a click in a chat that has written nothing yet still opens the panel with that file', async () => {
  localStorage.setItem('everflow.chat-files.ses_synthetic123', 'hidden');
  const { state } = chatWithFiles(() => [], { [PLAN]: () => '# Plan' }, { [PLAN]: file(PLAN, 'markdown', '2026-11-17T16:00:00Z') });
  board(state);
  await userEvent.click(screen.getByRole('button', { name: 'Open the chat of ticket #3' }));
  const dialog = await screen.findByRole('dialog');
  const frame = await within(dialog).findByTitle('Chat of ticket #3');
  expect(within(dialog).queryByRole('region', { name: 'Files of this chat' })).toBeNull();
  fromChat(frame, { type: 'everflow:open-file', path: PLAN });
  const viewer = await within(dialog).findByRole('region', { name: 'Files of this chat' });
  expect(await within(viewer).findByRole('heading', { name: 'Plan' })).toBeTruthy();
  expect(dialog.className).toMatch(/sm:w-\[min\(1800px,98vw\)\]/);
  expect(viewer.parentElement!.className.split(' ')).not.toContain('sm:hidden');
});

test('the dialog shows its own Close only when the chat view has not said its bridge runs within 6 seconds of loading', async () => {
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { state } = chatWithFiles(() => []);
  board(state);
  await userEvent.click(screen.getByRole('button', { name: 'Open the chat of ticket #3' }));
  const dialog = await screen.findByRole('dialog');
  let frame = await within(dialog).findByTitle('Chat of ticket #3');
  fireEvent.load(frame);
  await act(() => vi.advanceTimersByTimeAsync(5_900));
  expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(200));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  // with the bridge running, the view's own Close stays the only one
  await userEvent.click(screen.getByRole('button', { name: 'Open the chat of ticket #3' }));
  const again = await screen.findByRole('dialog');
  frame = await within(again).findByTitle('Chat of ticket #3');
  fromChat(frame, { type: 'everflow:ready' });
  fireEvent.load(frame);
  await act(() => vi.advanceTimersByTimeAsync(7_000));
  expect(within(again).queryByRole('button', { name: 'Close' })).toBeNull();
});

test('the file panel: copy path, preview or source, find with next and previous, outline, expand over the chat, close', async () => {
  localStorage.clear();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const text = '# Plan\n\nAlpha beta alpha.\n\n## Steps\n\nalpha again\n\n### Last';
  const { state } = chatWithFiles(() => [file(MD, 'markdown', '2026-11-17T16:45:00Z')], { [MD]: () => text });
  board(state);
  await userEvent.click(screen.getByRole('button', { name: 'Open the chat of ticket #3' }));
  const dialog = await screen.findByRole('dialog');
  const viewer = await within(dialog).findByRole('region', { name: 'Files of this chat' });
  await userEvent.click(await within(dialog).findByRole('button', { name: 'Show the files of this chat (1)' }));
  await within(viewer).findByRole('heading', { name: 'Plan' });

  await userEvent.click(within(viewer).getByRole('button', { name: 'Copy file path' }));
  expect(writeText).toHaveBeenCalledWith(MD);

  await userEvent.click(within(viewer).getByRole('button', { name: 'Outline' }));
  const outline = within(viewer).getByRole('navigation', { name: 'Outline of the file' });
  expect(within(outline).getAllByRole('button').map((item) => [item.textContent, item.style.paddingLeft])).toEqual([['Plan', '0.75rem'], ['Steps', '1.5rem'], ['Last', '2.25rem']]);
  await userEvent.click(within(outline).getByRole('button', { name: 'Steps' }));
  expect(within(viewer).queryByRole('navigation', { name: 'Outline of the file' })).toBeNull();

  await userEvent.click(within(viewer).getByRole('button', { name: 'Find in file' }));
  const input = within(viewer).getByRole('searchbox', { name: 'Find in file' });
  await userEvent.type(input, 'alpha');
  const count = within(viewer).getByRole('status', { name: 'Matches' });
  await waitFor(() => expect(count.textContent).toBe('1/3'));
  await userEvent.click(within(viewer).getByRole('button', { name: 'Next match' }));
  expect(count.textContent).toBe('2/3');
  await userEvent.keyboard('{Enter}');
  expect(count.textContent).toBe('3/3');
  await userEvent.keyboard('{Enter}');
  expect(count.textContent).toBe('1/3');
  await userEvent.click(within(viewer).getByRole('button', { name: 'Previous match' }));
  expect(count.textContent).toBe('3/3');

  // source: the file as written, numbered lines that find leaves out
  const preview = within(viewer).getByRole('button', { name: 'Preview' });
  expect(preview.getAttribute('aria-pressed')).toBe('true');
  await userEvent.click(preview);
  expect(preview.getAttribute('aria-pressed')).toBe('false');
  expect(within(viewer).queryByRole('heading')).toBeNull();
  expect(within(viewer).getByLabelText('Source').textContent).toContain('## Steps');
  await userEvent.clear(input);
  await userEvent.type(input, '1');
  await waitFor(() => expect(count.textContent).toBe('0/0'));
  await userEvent.click(preview);
  expect(await within(viewer).findByRole('heading', { name: 'Plan' })).toBeTruthy();

  // expand: the panel takes the dialog, the chat and its links step aside, a Close of the dialog shows in the panel
  const frame = within(dialog).getByTitle('Chat of ticket #3');
  await userEvent.click(within(viewer).getByRole('button', { name: 'Expand panel' }));
  expect(frame.parentElement!.className).toContain('sm:hidden');
  expect(within(viewer).getByRole('button', { name: 'Close the chat' }).className).not.toContain('sm:hidden');
  expect(within(dialog).getByRole('link', { name: 'Open the chat of ticket #3 in OpenChamber' }).parentElement!.parentElement!.className).toContain('sm:hidden');
  await userEvent.click(within(viewer).getByRole('button', { name: 'Collapse panel' }));
  expect(frame.parentElement!.className).not.toContain('sm:hidden');
  expect(within(viewer).getByRole('button', { name: 'Close the chat' }).className).toContain('sm:hidden');

  // close panel: the single column again, the strip's Files button brings it back
  await userEvent.click(within(viewer).getByRole('button', { name: 'Close panel' }));
  expect(dialog.className).toMatch(/sm:w-\[min\(1100px,96vw\)\]/);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Show the files of this chat (1)' }));
  expect(dialog.className).toMatch(/sm:w-\[min\(1800px,98vw\)\]/);
  localStorage.clear();
});

test('a closed ticket still opens its chat', () => {
  const state = uiState();
  state.groups.done_today[0]!.session_id = 'ses_closed123';
  board(state);
  const card = screen.getByRole('article', { name: 'Ticket #7: Closed work' });
  expect(within(card).getByText('Chat in OpenChamber, project Vault')).toBeTruthy();
  expect(within(card).getByRole('link', { name: 'Open the chat of ticket #7 in OpenChamber' }).getAttribute('href')).toBe('openchamber://session/ses_closed123');
});

test('a ticket whose chat is running says so on the card', () => {
  const state = uiState();
  Object.assign(state.groups.working[0]!, { session_id: 'ses_synthetic123', chat_running: true });
  board(state);
  const card = screen.getByRole('article', { name: 'Ticket #3: Active work' });
  expect(within(card).getByText('Chat working now, project Vault')).toBeTruthy();
  expect(within(card).queryByText(/Chat open in OpenChamber/)).toBeNull();
});

test('each live source account row has a pause switch; paused rows say what waits; agents show their client', async () => {
  const state = uiState();
  const at = '2026-11-06T06:00:00.000000Z';
  state.health.push(
    { dependency: 'teamsrelay', scope: 'source', state: 'ok', since: at, last_ok: at, last_error: null },
    { dependency: 'teamsrelay:me@bip.invalid', scope: 'account', state: 'ok', since: at, last_ok: at, last_error: null, paused: false, waiting: 0, clients: ['bip'] },
    { dependency: 'teamsrelay:me@npo.invalid', scope: 'account', state: 'ok', since: at, last_ok: at, last_error: null, paused: true, waiting: 2, clients: ['npo'] },
    { dependency: 'teamsrelay:off@npo.invalid', scope: 'account', state: 'disabled', since: null, last_ok: null, last_error: null, paused: false, waiting: 0, clients: [] },
  );
  state.agents = [{ kind: 'triage', clients: ['bip'], title: 'Fresh request', ticket: null }, { kind: 'chat', clients: ['npo'], title: 'AKS check', ticket: 6 }];
  state.triaging = [{ id: 21, title: 'Noisy chat', source: 'teamsrelay', account: 'me@npo.invalid', created_at: '2026-11-06T05:58:00.000000Z', job: null,
    clients: ['npo'], held: true, messages: [] }];
  board(state);
  const health = screen.getByRole('region', { name: 'Health' });
  expect(health.querySelector('[data-node="triage"]')!.textContent).toContain('bipFresh request');
  expect(health.querySelector('[data-node="openchamber"]')!.textContent).toContain('npo#6 AKS check');
  const switches = within(health).getAllByRole('switch');
  expect(switches.map((item) => item.getAttribute('aria-label'))).toEqual(['Triage me@bip.invalid', 'Triage me@npo.invalid']);
  expect(switches.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  expect(health.textContent).toContain('paused, 2 waiting');
  expect(screen.queryByText('Clients')).toBeNull();
  await userEvent.click(switches[0]!);
  const [path, init] = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(path).toBe('/api/input');
  expect(JSON.parse(String(init!.body))).toEqual({ source: 'teamsrelay', account: 'me@bip.invalid', paused: true });
  const card = screen.getByRole('heading', { name: 'Batch #21: Noisy chat' }).closest<HTMLElement>('[data-triage-batch]')!;
  expect(within(card).getByRole('status').textContent).toBe('Held: me@npo.invalid paused');
});

test('triage and chat pick model and effort the same way, triage only among its own accounts; stale option lists ask the daemon once', async () => {
  const state = uiState();
  state.health.push({ dependency: 'provider:first', scope: 'provider', state: 'failing', since: null, last_ok: null, last_error: 'down' });
  state.models.options = { at: null, error: 'Model list: OpenCode HTTP 503', requested_at: null,
    chat: [{ id: 'meridian-auto/claude-opus-5-5', name: 'Opus auto', efforts: ['high', 'max'] }, { id: 'meridian-roar/claude-sonnet-5-5', name: 'Sonnet roar', efforts: ['low'] },
      { id: 'first/claude-haiku-5-5', name: 'Haiku 5.5 #2', efforts: ['none', 'low'] }, { id: 'second/claude-opus-5-5', name: 'Opus 5.5 #1', efforts: ['high'] }],
    accounts: { first: 'Claude #2 (everbright)', 'meridian-auto': 'Claude auto (pool)', 'meridian-roar': 'Claude #3 (roar)' } };
  state.models.triage_routes = ['first', 'second'];
  state.models.chat = { model: 'meridian-auto/claude-opus-5-5', effort: 'max', default_model: 'meridian-auto/claude-opus-5-5', overridden: true };
  board(state);
  const health = screen.getByRole('region', { name: 'Health' });
  await waitFor(() => expect(fetcher.mock.calls.some(([path, init]) => path === '/api/setting' && String(init?.body) === '{"refresh":true}')).toBe(true));
  const triage = health.querySelector<HTMLElement>('[data-node="triage"]')!;
  expect(within(triage).getByText('Accounts, automatic failover')).toBeTruthy();
  expect(within(triage).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Claude #2 (everbright)failingdown', 'secondnot used yet']);
  expect(within(triage).getByRole('button', { name: 'Triage model' }).textContent).toBe('Haiku 5.5 #2');
  expect(within(triage).getByText(/^Account:/).textContent).toBe('Account: Claude #2 (everbright)');
  expect(within(triage).getByRole('alert').textContent).toBe('Model list: OpenCode HTTP 503');
  // Only the triage accounts' models, under their account like the chat list; Meridian has no `none` effort
  fireEvent.click(within(triage).getByRole('button', { name: 'Triage model' }));
  const triageModels = await screen.findByRole('listbox', { name: 'Triage model' });
  expect(within(triageModels).getAllByRole('option').map((option) => option.textContent)).toEqual(['Haiku 5.5 #2defaultclaude-haiku-5-5', 'Opus 5.5 #1claude-opus-5-5']);
  expect(within(triageModels).getAllByRole('presentation').map((group) => group.textContent)).toEqual(['Claude #2 (everbright)', 'second']);
  fireEvent.keyDown(triageModels, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Triage model' })).toBeNull());
  fireEvent.click(within(triage).getByRole('button', { name: 'Triage effort' }));
  const triageEfforts = await screen.findByRole('listbox', { name: 'Triage effort' });
  expect(within(triageEfforts).getAllByRole('option').map((option) => option.textContent)).toEqual(["Default effortmodel's own", 'low']);
  fireEvent.keyDown(triageEfforts, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Triage effort' })).toBeNull());
  const chat = health.querySelector<HTMLElement>('[data-node="openchamber"]')!;
  expect(within(chat).getByRole('button', { name: 'Chat model' }).textContent).toBe('Opus auto');
  expect(within(chat).getByText(/^Account:/).textContent).toBe('Account: Claude auto (pool) · next account by priority when one runs out');
  fireEvent.click(within(chat).getByRole('button', { name: 'Chat effort' }));
  const efforts = await screen.findByRole('listbox', { name: 'Chat effort' });
  expect(within(efforts).getAllByRole('option').map((option) => [option.textContent, option.getAttribute('aria-selected')]))
    .toEqual([["Default effortmodel's own", 'false'], ['high', 'false'], ['max', 'true']]);
  fireEvent.keyDown(efforts, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Chat effort' })).toBeNull());
  fetcher.mockClear();
  fireEvent.click(within(chat).getByRole('button', { name: 'Chat model' }));
  const search = await screen.findByRole('combobox', { name: 'Search models' });
  fireEvent.change(search, { target: { value: 'sonnet' } });
  const models = screen.getByRole('listbox', { name: 'Chat model' });
  expect(within(models).getAllByRole('option').map((option) => option.textContent)).toEqual(['Sonnet roarclaude-sonnet-5-5']);
  expect(within(models).getByRole('presentation').textContent).toBe('Claude #3 (roar)');
  fireEvent.change(search, { target: { value: 'nothing here' } });
  expect(screen.getByText('No match')).toBeTruthy();
  fireEvent.change(search, { target: { value: 'roar' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)))).toEqual([
    { key: 'chat.model', value: 'meridian-roar/claude-sonnet-5-5' }, { key: 'chat.effort', value: '' }]));
  fetcher.mockClear();
  fireEvent.click(within(triage).getByRole('button', { name: 'Triage model' }));
  fireEvent.click(within(await screen.findByRole('listbox', { name: 'Triage model' })).getByRole('option', { name: /^Opus 5\.5 #1/ }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body))))
    .toEqual([{ key: 'triage.model', value: 'second/claude-opus-5-5' }]));
});

test('a batch in triage shows at the top of Needs you before its ticket exists', async () => {
  const state = uiState();
  state.triaging = [{ id: 20, title: 'Fresh request', source: 'teamsrelay', account: 'me@example.invalid', created_at: '2026-11-06T05:58:00.000000Z', job: 'running',
    clients: ['bip'], held: false, messages: [{ id: 30, source: 'teamsrelay', sender: 'Colleague', sent_at: '2026-11-06T05:58:00.000000Z', text: 'Can you check the VPN?', attachments: [] }] }];
  board(state);
  const column = screen.getByRole('region', { name: 'Needs you (3)' });
  const card = within(column).getByRole('heading', { name: 'Batch #20: Fresh request' }).closest<HTMLElement>('[data-triage-batch]')!;
  expect(column.querySelector('[data-triage-batch], article')).toBe(card);
  expect(within(card).getByRole('status').textContent).toBe('Triage running for bip');
  await userEvent.click(within(card).getByRole('button', { name: 'Messages (1)' }));
  expect(within(card).getByText('Can you check the VPN?')).toBeTruthy();
  expect(card.getAttribute('draggable')).toBeNull();
});

test('dragging a ticket to Working starts it, to Done today or Skipped opens the matching confirmation', async () => {
  board();
  const column = (name: string) => screen.getByRole('region', { name });
  const drag = (card: HTMLElement, target: HTMLElement) => {
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => ''), effectAllowed: 'all', dropEffect: 'none' };
    fireEvent.dragStart(card, { dataTransfer });
    const accepted = !fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    fireEvent.dragEnd(card, { dataTransfer });
    return accepted;
  };
  expect(ticket().getAttribute('draggable')).toBe('true');
  expect(drag(ticket(), column('Working (1)'))).toBe(true);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/ticket/1/start', expect.objectContaining({ method: 'POST' })));

  expect(drag(ticket(2, 'Second proposal'), column('Done (1)'))).toBe(true);
  expect(await screen.findByRole('dialog', { name: 'Mark ticket #2 done' })).toBeTruthy();
  await userEvent.keyboard('{Escape}');

  expect(drag(ticket(2, 'Second proposal'), column('Skipped (4)'))).toBe(true);
  expect(await screen.findByRole('dialog', { name: 'Dismiss ticket #2' })).toBeTruthy();
  await userEvent.keyboard('{Escape}');

  const active = ticket(3, 'Active work');
  expect(drag(active, column('Needs you (2)'))).toBe(false);
  expect(drag(active, column('Working (1)'))).toBe(false);
  expect(screen.getByRole('article', { name: 'Ticket #6: Dismissed work' }).getAttribute('draggable')).toBe('false');
  expect(fetcher.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);
});

test('a skipped batch shows why triage skipped it and drags onto Needs you to make a ticket', async () => {
  board();
  const batch = screen.getByRole('heading', { name: 'Batch #10: Skipped source' }).closest<HTMLElement>('[data-batch-id]')!;
  expect(within(batch).getByText('Greeting only, nothing to do').className).toContain('line-clamp');
  await userEvent.click(within(batch).getByRole('button', { name: 'Expand batch #10' }));
  const dialog = await screen.findByRole('dialog', { name: 'Skipped source' });
  expect(within(dialog).getByText('Greeting only, nothing to do').className).not.toContain('line-clamp');
  expect(within(dialog).getByText('No source messages.')).toBeTruthy();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(within(batch).queryByText(/2026-11-06/)).toBeNull();
  expect(within(batch).getByRole('button', { name: 'Mute chat of batch #10' }).textContent).not.toContain('Mute');
  expect(batch.getAttribute('draggable')).toBe('true');
  const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => ''), effectAllowed: 'all', dropEffect: 'none' };
  fireEvent.dragStart(batch, { dataTransfer });
  expect(fireEvent.dragOver(screen.getByRole('region', { name: 'Working (1)' }), { dataTransfer })).toBe(true);
  const needs = screen.getByRole('region', { name: 'Needs you (2)' });
  expect(fireEvent.dragOver(needs, { dataTransfer })).toBe(false);
  fireEvent.drop(needs, { dataTransfer });
  fireEvent.dragEnd(batch, { dataTransfer });
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/batch/10/ticket', expect.objectContaining({ method: 'POST', body: '{}' })));
});

test('six board columns have counts; health, Problems and persisted feedback remain outside columns', () => {
  board();
  expect(document.querySelectorAll('[data-column]')).toHaveLength(6);
  for (const name of ['Needs you (2)', 'Working (1)', 'Waiting on them (1)', 'Failed (1)', 'Done (1)', 'Skipped (4)']) expect(screen.getByRole('region', { name })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Skipped (4)' })).getByRole('article', { name: 'Ticket #6: Dismissed work' })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Done (1)' })).queryByRole('article', { name: 'Ticket #6: Dismissed work' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Health' }).textContent).toContain('Source unavailable');
  expect(screen.getByRole('region', { name: 'Health' }).textContent).toContain('OpenChamber');
  const problems = screen.getByRole('region', { name: 'Problems' });
  expect(problems.textContent).toContain('Unbound job #77');
  expect(problems.textContent).toContain('Expected JSON object');
  expect(problems.textContent).toContain('<bad-output>');
  expect(problems.textContent).toContain('raw invalid response');
  expect(problems.textContent).toContain('<quarantined>');
  expect(screen.getByText('Dismissed: 4. Made tickets: 2.')).toBeTruthy();
  expect(problems.closest('[data-column]')).toBeNull();
  const working = screen.getByRole('region', { name: 'Working (1)' });
  expect(within(working).getByText('Membership checked')).toBeTruthy();
  expect(within(working).getByText('Idle')).toBeTruthy();
});

test('proposed fields, safe refs, expandable literal messages and newest-first detail are visible', async () => {
  const state = uiState();
  state.groups.needs_you[0]!.messages[0]!.text = '<script>globalThis.injected=true</script><img src=x onerror=bad()>';
  state.groups.needs_you[0]!.refs.push({ id: 3, kind: 'jira', key: '<img onerror=bad()>', url: 'javascript:bad()', seen_in: 'message' });
  fetcher.mockImplementation(async () => Response.json(uiDetail()));
  board(state);
  const first = ticket();
  for (const value of ['North', '88%', 'Maybe #42']) expect(first.textContent).toContain(value);
  expect(within(first).getByText(/Age:/)).toBeTruthy();
  await userEvent.click(within(first).getByRole('button', { name: 'Expand ticket #1' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reset access' });
  for (const value of ['Confirm access scope', 'Check membership first', '01_Projects/access.md']) expect(dialog.textContent).toContain(value);
  const link = within(dialog).getByRole('link', { name: 'OPS-123' });
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(within(dialog).queryByRole('link', { name: '<img onerror=bad()>' })).toBeNull();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await userEvent.click(within(first).getByRole('button', { name: 'Messages (2)' }));
  expect(within(first).getByText('<script>globalThis.injected=true</script><img src=x onerror=bad()>')).toBeTruthy();
  expect(first.querySelector('script,img')).toBeNull();
  await userEvent.click(within(first).getByRole('button', { name: 'Timeline' }));
  await screen.findByText('Newest timeline event');
  const events = within(first).getByRole('list', { name: 'Timeline events' });
  expect(within(events).getAllByRole('listitem').map((node) => node.textContent)).toEqual([expect.stringContaining('Newest timeline event'), expect.stringContaining('Older timeline event')]);
});

test('Discuss dialog commits the exact question, traps focus, ignores shortcuts and restores trigger', async () => {
  const user = userEvent.setup();
  board();
  const trigger = within(ticket()).getByRole('button', { name: 'Discuss' });
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Discuss ticket #1 in OpenChamber' });
  expect(within(dialog).getByText(/Nothing is done until you decide there/)).toBeTruthy();
  const field = within(dialog).getByRole('textbox', { name: 'What to discuss (optional)' });
  expect(document.activeElement).toBe(field);
  await user.type(field, 'Exact note\nSecond line jskcd/');
  await user.tab({ shift: true });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Open chat' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetcher).toHaveBeenCalledWith('/api/ticket/1/discuss', expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'Exact note\nSecond line jskcd/' }),
    headers: expect.objectContaining({ 'x-everflow-token': 'per-start-token', 'content-type': 'application/json' }) }));
  expect(document.activeElement).toBe(trigger);
});

test('dismiss dialog accepts optional reason and displays actual server errors beside the field', async () => {
  fetcher.mockResolvedValue(Response.json({ error: { message: 'Ticket already terminal' } }, { status: 409 }));
  board();
  const trigger = within(ticket()).getByRole('button', { name: 'Dismiss' });
  await userEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Dismiss ticket #1' });
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason (optional)' }), 'Duplicate');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm dismiss' }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Ticket already terminal');
  expect(within(dialog).getByRole('textbox').getAttribute('aria-describedby')).toBeTruthy();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test('done dialog closes a ticket with an optional reason and does not dismiss it', async () => {
  fetcher.mockImplementation(async (_input: string, init?: RequestInit) => init?.method === 'POST' ? Response.json({ ticket: 1 }) : new Response(null, { status: 304 }));
  board();
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Mark done' }));
  const dialog = screen.getByRole('dialog', { name: 'Mark ticket #1 done' });
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason (optional)' }), 'Replied by hand');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm done' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetcher).toHaveBeenCalledWith('/api/ticket/1/close', expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'Replied by hand' }) }));
  expect(fetcher).not.toHaveBeenCalledWith('/api/ticket/1/dismiss', expect.anything());
});

test('Discuss without a question opens the chat with an empty body', async () => {
  fetcher.mockImplementation(async (_input: string, init?: RequestInit) => init?.method === 'POST' ? Response.json({ ticket: 1 }) : new Response(null, { status: 304 }));
  board();
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Discuss' }));
  const dialog = screen.getByRole('dialog', { name: 'Discuss ticket #1 in OpenChamber' });
  await userEvent.type(within(dialog).getByRole('textbox'), '   ');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Open chat' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetcher).toHaveBeenCalledWith('/api/ticket/1/discuss', expect.objectContaining({ method: 'POST', body: '{}' }));
});

test('dialog close uses search fallback when committed refresh removes its trigger card', async () => {
  const changed = uiState();
  changed.groups.needs_you = changed.groups.needs_you.filter((item) => item.id !== 1);
  fetcher.mockImplementation(async (_input: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { ticket: 1 } : changed));
  board();
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Discuss' }));
  const dialog = screen.getByRole('dialog', { name: 'Discuss ticket #1 in OpenChamber' });
  await userEvent.type(within(dialog).getByRole('textbox'), 'Exact note');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Open chat' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search tickets' })));
});

test('bulk dismissal clears successful selection, retains failed selection and displays per-card errors', async () => {
  fetcher.mockImplementation(async (input: string, init?: RequestInit) => init?.method !== 'POST' ? new Response(null, { status: 304 })
    : input.includes('/1/') ? Response.json({ ticket: 1 }) : Response.json({ error: { message: 'Ticket #2 conflict' } }, { status: 409 }));
  board();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select ticket #1' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select ticket #2' }));
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss selected (2)' }));
  const dialog = screen.getByRole('dialog', { name: 'Dismiss 2 selected tickets' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm dismiss' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('checkbox', { name: 'Select ticket #1' }).getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('checkbox', { name: 'Select ticket #2' }).getAttribute('aria-checked')).toBe('true');
  expect(within(ticket(2, 'Second proposal')).getByRole('alert').textContent).toBe('Ticket #2 conflict');
});

test('Retry parked job and Make ticket for all skipped outcomes use guarded local actions', async () => {
  board();
  await userEvent.click(screen.getByRole('button', { name: 'Retry job #77' }));
  expect(fetcher).toHaveBeenCalledWith('/api/job/77/retry', expect.objectContaining({ method: 'POST', body: '{}' }));
  for (const id of [10, 11, 12]) {
    await userEvent.click(screen.getByRole('button', { name: `Make ticket from batch #${id}` }));
    expect(fetcher).toHaveBeenCalledWith(`/api/batch/${id}/ticket`, expect.objectContaining({ method: 'POST', body: '{}' }));
  }
});

test('skipped chat Mute, dismiss with mute, muted list Unmute and switched-off accounts use guarded local actions', async () => {
  const state = uiState();
  state.skipped.push({ id: 13, title: 'Muted source', outcome: 'muted', source: 'teams', account: 'test@example.invalid', created_at: '2026-11-06T06:00:00.000000Z', reason: null, messages: [] });
  state.muted = [{ id: 5, title: 'Noisy group', source: 'teams', account: 'test@example.invalid', until: '9999-12-31T23:59:59.000000Z', forever: true }];
  state.health.push({ dependency: 'teams:off@example.invalid', scope: 'account', state: 'disabled', since: null, last_ok: null, last_error: null });
  board(state);
  expect(screen.queryByRole('button', { name: 'Mute chat of batch #13' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Make ticket from batch #13' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Health' }).textContent).toContain('off@example.invalid');
  expect(screen.getByRole('region', { name: 'Health' }).textContent).toMatch(/off@example\.invalidoff/);

  await userEvent.click(screen.getByRole('button', { name: 'Mute chat of batch #10' }));
  const mute = screen.getByRole('dialog', { name: 'Mute Skipped source' });
  const group = within(mute).getByRole('group', { name: 'Mute for' });
  expect((within(group).getByRole('radio', { name: '1 h' }) as HTMLInputElement).checked).toBe(true);
  expect(within(group).queryByRole('radio', { name: "Don't mute" })).toBeNull();
  expect(within(group).getByText(/^Muted until /)).toBeTruthy();
  await userEvent.click(within(group).getByRole('radio', { name: '30 min' }));
  await userEvent.click(within(mute).getByRole('button', { name: 'Mute chat' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetcher).toHaveBeenCalledWith('/api/batch/10/mute', expect.objectContaining({ method: 'POST', body: JSON.stringify({ minutes: 30 }) }));

  await userEvent.click(screen.getByRole('button', { name: 'Mute chat of batch #10' }));
  const custom = screen.getByRole('dialog', { name: 'Mute Skipped source' });
  await userEvent.click(within(custom).getByRole('radio', { name: 'Custom' }));
  const amount = within(custom).getByRole('spinbutton', { name: 'Duration' });
  await userEvent.clear(amount);
  await userEvent.type(amount, '0');
  expect(within(custom).getByText('Enter a whole number, up to one year.')).toBeTruthy();
  expect((within(custom).getByRole('button', { name: 'Mute chat' }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.clear(amount);
  await userEvent.type(amount, '3');
  await userEvent.selectOptions(within(custom).getByRole('combobox', { name: 'Unit' }), 'hours');
  await userEvent.click(within(custom).getByRole('button', { name: 'Mute chat' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetcher).toHaveBeenCalledWith('/api/batch/10/mute', expect.objectContaining({ method: 'POST', body: JSON.stringify({ minutes: 180 }) }));

  await userEvent.click(within(ticket()).getByRole('button', { name: 'Dismiss' }));
  const dismiss = screen.getByRole('dialog', { name: 'Dismiss ticket #1' });
  expect((within(dismiss).getByRole('radio', { name: "Don't mute" }) as HTMLInputElement).checked).toBe(true);
  await userEvent.click(within(dismiss).getByRole('radio', { name: 'Until unmuted' }));
  await userEvent.click(within(dismiss).getByRole('button', { name: 'Confirm dismiss' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetcher).toHaveBeenCalledWith('/api/ticket/1/dismiss', expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: '', mute_minutes: null }) }));

  const muted = screen.getByRole('region', { name: 'Muted chats (1)' });
  expect(muted.textContent).toContain('until unmuted');
  await userEvent.click(within(muted).getByRole('button', { name: 'Unmute Noisy group' }));
  expect(fetcher).toHaveBeenCalledWith('/api/conversation/5/unmute', expect.objectContaining({ method: 'POST', body: '{}' }));
});

test('j/k focus cards; s/c/d and slash activate visible controls', async () => {
  const user = userEvent.setup();
  board();
  fireEvent.keyDown(document, { key: 'j' });
  expect(document.activeElement).toBe(ticket());
  await user.keyboard('j');
  expect(document.activeElement).toBe(ticket(2, 'Second proposal'));
  await user.keyboard('k');
  expect(document.activeElement).toBe(ticket());
  await user.keyboard('l');
  expect(document.activeElement).toBe(ticket(3, 'Active work'));
  await user.keyboard('h');
  expect(document.activeElement).toBe(ticket());
  await user.keyboard('s');
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/ticket/1/start', expect.objectContaining({ method: 'POST' })));
  ticket().focus();
  await user.keyboard('c');
  expect(screen.getByRole('dialog', { name: 'Discuss ticket #1 in OpenChamber' })).toBeTruthy();
  await user.keyboard('{Escape}');
  ticket().focus();
  await user.keyboard('d');
  expect(screen.getByRole('dialog', { name: 'Dismiss ticket #1' })).toBeTruthy();
  await user.keyboard('{Escape}');
  ticket().focus();
  await user.keyboard('/');
  expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search tickets' }));
});

test('shortcuts ignore editing, contenteditable, native select and modified keys', async () => {
  render(<><TicketBoard initialState={uiState()} initialEtag={'"initial"'} token="per-start-token" />
    <input aria-label="Other input" /><textarea aria-label="Other textarea" /><select aria-label="Other select"><option>First</option></select>
    <div contentEditable tabIndex={0} aria-label="Rich input" role="textbox" /></>);
  for (const label of ['Other input', 'Other textarea', 'Other select', 'Rich input']) {
    const field = screen.getByLabelText(label);
    field.focus();
    for (const key of ['j', 'k', 's', 'c', 'd', '/']) fireEvent.keyDown(field, { key });
    expect(document.activeElement).toBe(field);
    expect(screen.queryByRole('dialog')).toBeNull();
  }
  ticket().focus();
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  expect(fetcher).not.toHaveBeenCalled();
});

test('search finds verified session title without inventing a deep link', async () => {
  board();
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search tickets' }), 'North access investigation');
  expect(ticket(3, 'Active work')).toBeTruthy();
  expect(ticket(3, 'Active work').querySelector('a[href*="session"]')).toBeNull();
});

test('polls at 10 seconds with If-None-Match and never parses a 304', async () => {
  vi.useFakeTimers();
  const json = vi.fn(() => { throw new Error('304 has no JSON'); });
  fetcher.mockResolvedValue({ status: 304, ok: false, json });
  board();
  await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetcher).toHaveBeenCalledWith('/api/state', expect.objectContaining({ headers: { 'if-none-match': '"initial"' }, signal: expect.any(AbortSignal) }));
  expect(json).not.toHaveBeenCalled();
  expect(ticket()).toBeTruthy();
});

test('age advances on unchanged polling without changing persisted state timestamps', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
  board();
  expect(within(ticket()).getByText('Age: 0m')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(within(ticket()).getByText('Age: 1m')).toBeTruthy();
});

test('poll failure preserves last good state and first unreachable time; recovery clears banner', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
  fetcher.mockRejectedValue(new TypeError('Connection refused'));
  board();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  const first = screen.getByRole('alert').textContent;
  expect(first).toContain('Unreachable since');
  expect(ticket()).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByRole('alert').textContent).toBe(first);
  fetcher.mockResolvedValue(new Response(null, { status: 304 }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.queryByRole('alert')).toBeNull();
});

test.each(['headers', 'body'])('state %s deadline reports first-unreachable, releases single flight and recovers', async (stall) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
  let signal: AbortSignal | undefined;
  fetcher.mockImplementationOnce((_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return stall === 'headers' ? new Promise(() => {}) : Promise.resolve({ status: 200, ok: true, headers: new Headers(), json: () => new Promise(() => {}) });
  });
  fetcher.mockResolvedValue(new Response(null, { status: 304 }));
  board();
  await act(async () => { await vi.advanceTimersByTimeAsync(18_000); });
  expect(signal!.aborted).toBe(true);
  const first = screen.getByRole('alert').textContent;
  expect(first).toContain('Unreachable since');
  expect(ticket()).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('unmount abort is distinct from timeout and clears the request deadline', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  fetcher.mockImplementation((_url: string, init: RequestInit) => { signal = init.signal as AbortSignal; return new Promise(() => {}); });
  const view = board();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  await act(async () => { view.unmount(); });
  expect(signal!.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('refresh preserves selection, expanded messages/timeline and focused card', async () => {
  const state = uiState();
  const interval = vi.spyOn(globalThis, 'setInterval');
  fetcher.mockResolvedValue(Response.json(uiDetail()));
  board(state);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select ticket #1' }));
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Messages (2)' }));
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Timeline' }));
  await screen.findByText('Newest timeline event');
  const original = ticket();
  original.focus();
  const changed = uiState();
  changed.groups.needs_you[0]!.summary = 'Refreshed summary';
  fetcher.mockImplementation(async (input: string) => Response.json(input.includes('/api/ticket/') ? uiDetail() : changed, { headers: { etag: '"new"' } }));
  const tick = interval.mock.calls.find(([, delay]) => delay === 10_000)![0] as () => void;
  await act(async () => tick());
  expect(within(original).getByText('Refreshed summary')).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Select ticket #1' }).getAttribute('aria-checked')).toBe('true');
  expect(within(original).getByText('Newest source message')).toBeTruthy();
  expect(within(original).getByText('Newest timeline event')).toBeTruthy();
  expect(document.activeElement).toBe(original);
});

test('message images show as thumbnails that open large; a file the relay cannot give says why', async () => {
  const state = uiState();
  state.groups.needs_you[0]!.messages = [{ id: 7, source: 'teamsrelay', sender: 'Colleague', sent_at: AT, text: 'VPN error', attachments: [
    { name: 'image 1', kind: 'image', url: '/api/message/7/attachment/1' },
    { name: 'shot.png', kind: 'image', url: null },
    { name: 'report.xlsx', kind: 'file', url: '/api/message/7/attachment/3' }] }];
  board(state);
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Messages (1)' }));
  const list = within(ticket()).getByRole('list', { name: 'Attachments' });
  expect(within(list).getByRole('img', { name: 'image 1' }).getAttribute('src')).toBe('/api/message/7/attachment/1');
  expect(within(list).getByText('shot.png').closest('a')).toBeNull();
  await userEvent.click(within(list).getByRole('button', { name: 'Show image 1' }));
  const dialog = await screen.findByRole('dialog', { name: 'image 1' });
  expect(within(dialog).getByRole('img', { name: 'image 1' })).toBeTruthy();
  await userEvent.keyboard('{Escape}');
  fetcher.mockResolvedValue(Response.json({ error: { code: 'attachment.unavailable', message: 'This Teams account runs without a browser' } }, { status: 409 }));
  await userEvent.click(within(list).getByText('report.xlsx'));
  expect((await within(list).findByRole('status')).textContent).toBe('This Teams account runs without a browser');
  expect(fetcher).toHaveBeenCalledWith('/api/message/7/attachment/3', { cache: 'no-store' });
});

test('expanded timeline refreshes its content without collapsing or moving card focus', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval');
  let detail = uiDetail();
  const state = uiState();
  fetcher.mockImplementation(async (input: string) => Response.json(input.includes('/api/ticket/') ? detail : state, { headers: { etag: '"changed"' } }));
  board();
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Timeline' }));
  await screen.findByText('Newest timeline event');
  const original = ticket();
  original.focus();
  detail = { ...detail, timeline: [{ id: 30, at: '2026-11-06T07:00:00Z', kind: 'status', actor: 'chat', body: 'Newly collected event', link: null }, ...detail.timeline] };
  state.groups.needs_you[0]!.summary = 'Updated summary';
  state.groups.needs_you[0]!.timeline_revision = 'synthetic-new-event';
  const tick = interval.mock.calls.find(([, delay]) => delay === 10_000)![0] as () => void;
  await act(async () => tick());
  expect(await within(original).findByText('Newly collected event')).toBeTruthy();
  expect(within(original).getByRole('button', { name: 'Timeline' }).getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement === original).toBe(true);
});

test('timeline-only server change invalidates state and refreshes expanded detail without focus loss', async () => {
  const fixture = webFixture();
  using db = new DatabaseSync(fixture.path);
  const interval = vi.spyOn(globalThis, 'setInterval');
  const initial = readState(db, fixture.cfg);
  const initialEtag = representation(initial).etag;
  fetcher.mockImplementation(async (input: string, init?: RequestInit) => {
    if (input.includes('/api/ticket/')) return Response.json(ticketDetail(db, fixture.proposal));
    const state = readState(db, fixture.cfg);
    const { etag } = representation(state);
    return new Headers(init?.headers).get('if-none-match') === etag ? new Response(null, { status: 304 }) : Response.json(state, { headers: { etag } });
  });
  render(<TicketBoard initialState={initial} initialEtag={initialEtag} token="synthetic-token" />);
  const original = screen.getByRole('article', { name: `Ticket #${fixture.proposal}: Review synthetic access` });
  await userEvent.click(within(original).getByRole('button', { name: 'Timeline' }));
  await within(original).findByRole('list', { name: 'Timeline events' });
  original.focus();
  db.prepare("INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (?,?,'failure','chat','Timeline-only new event','rtl-timeline-only')")
    .run(fixture.proposal, new Date().toISOString());
  const tick = interval.mock.calls.find(([, delay]) => delay === 10_000)![0] as () => void;
  await act(async () => tick());
  expect(await within(original).findByText('Timeline-only new event')).toBeTruthy();
  expect(within(original).getByRole('button', { name: 'Timeline' }).getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement === original).toBe(true);
});

test('tab title counts Needs you and Failed, and a chime plays only when the count grows', async () => {
  const tones: number[] = [];
  vi.stubGlobal('AudioContext', class {
    currentTime = 0;
    destination = {};
    resume() { return Promise.resolve(); }
    createOscillator() { return { frequency: { value: 0 }, connect: (node: unknown) => node, start() {}, stop() { tones.push(this.frequency.value); } }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node: unknown) => node }; }
  });
  const interval = vi.spyOn(globalThis, 'setInterval');
  board();
  expect(document.title).toBe('(3) Everflow');
  expect(tones).toHaveLength(0);
  const grown = uiState();
  grown.groups.needs_you.push({ ...grown.groups.needs_you[0]!, id: 9, title: 'Fresh ask' });
  fetcher.mockImplementation(async () => Response.json(grown, { headers: { etag: '"grown"' } }));
  const tick = interval.mock.calls.find(([, delay]) => delay === 10_000)![0] as () => void;
  await act(async () => tick());
  await waitFor(() => expect(document.title).toBe('(4) Everflow'));
  expect(tones).toEqual([880, 1320]);
  const cleared = uiState();
  cleared.groups.needs_you = [];
  cleared.groups.failed = [];
  fetcher.mockImplementation(async () => Response.json(cleared, { headers: { etag: '"cleared"' } }));
  await act(async () => tick());
  await waitFor(() => expect(document.title).toBe('Everflow'));
  expect(tones).toHaveLength(2);
});

test('403 action displays reload notice and never retries stale approval', async () => {
  fetcher.mockResolvedValue(Response.json({ error: { message: 'Action token rejected' } }, { status: 403 }));
  board();
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Start' }));
  expect(await screen.findByRole('button', { name: 'Reload page' })).toBeTruthy();
  expect(screen.getAllByRole('alert').some((node) => node.textContent?.includes('Reload'))).toBe(true);
  const calls = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').length;
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Start' }));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(calls);
});

test('mute choices turn into minutes: presets, tomorrow 9:00 local, custom units, and out-of-range custom values', () => {
  const now = new Date(2026, 10, 12, 22, 30);
  expect(muteMinutes('', '', 'minutes', now)).toBeUndefined();
  expect(muteMinutes('always', '', 'minutes', now)).toBeNull();
  expect(muteMinutes('120', '', 'minutes', now)).toBe(120);
  expect(muteMinutes('tomorrow', '', 'minutes', now)).toBe(630);
  expect(muteMinutes('custom', '2', 'days', now)).toBe(2_880);
  for (const amount of ['', '0', '1.5', '-3', '366']) expect(muteMinutes('custom', amount, 'days', now)).toBeNaN();
});

test('an action refused after a server restart is sent once more with the token of the page as served now', async () => {
  const next = 'a'.repeat(64), used: string[] = [];
  fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const token = new Headers(init.headers).get('x-everflow-token')!;
      used.push(token);
      return token === next ? Response.json({ ticket: 1 }) : Response.json({ error: { message: 'Action token or Origin rejected.' } }, { status: 403 });
    }
    if (String(input) === '/') return new Response(`<html><head><meta name="everflow-token" content="${next}"/></head></html>`);
    return new Response(null, { status: 304 });
  });
  board();
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Start' }));
  expect(await screen.findByText('Local action saved.')).toBeTruthy();
  expect(used).toEqual(['per-start-token', next]);
  expect(screen.queryByRole('button', { name: 'Reload page' })).toBeNull();
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Start' }));
  await waitFor(() => expect(used).toEqual(['per-start-token', next, next]));
});

test('only submitting action disabled, then unmount aborts work and clears polling', async () => {
  let signal: AbortSignal | undefined;
  fetcher.mockImplementation((_url, init: RequestInit) => { signal = init.signal as AbortSignal; return new Promise(() => {}); });
  const view = board();
  const start = within(ticket()).getByRole('button', { name: 'Start' });
  await userEvent.click(start);
  expect((within(ticket()).getByRole('button', { name: 'Saving Start' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(ticket()).getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(false);
  vi.useFakeTimers();
  view.unmount();
  expect(signal!.aborted).toBe(true);
  const count = fetcher.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(count);
});

test('tickets disabled retains health and Problems with no work controls; chats off cannot approve', () => {
  const disabled = uiState();
  disabled.tickets_enabled = false;
  const view = board(disabled);
  expect(screen.getByText('Tickets disabled')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Health' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry job #77' })).toBeNull();
  view.unmount();
  const chatsOff = uiState();
  chatsOff.chats_enabled = false;
  board(chatsOff);
  expect(screen.getByText('Chats off')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Discuss' })).toBeNull();
});
