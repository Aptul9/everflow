// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TicketBoard } from '../../src/components/tickets/ticket-board.tsx';
import { uiDetail, uiState } from './fixtures.ts';
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

test('Google Chat recent-topic coverage is explicit on the health page', () => {
  const state = uiState();
  state.health.push(Object.assign({ dependency: 'gchat', scope: 'source' as const, state: 'ok' as const, since: null, last_ok: null, last_error: null }, { coverage: 'recent-topics' as const, observed_at: '2026-11-07T10:00:00Z' }));
  board(state);
  expect(screen.getByRole('region', { name: 'Health' }).textContent).toContain('Recent topics only');
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

test('a proposed ticket keeps all four actions inside the card, with Chat as an icon', () => {
  board();
  const chat = within(ticket()).getByRole('button', { name: 'Open chat with note' });
  expect(chat.textContent).not.toContain('Chat');
  // A row too narrow for the label keeps the icon and the accessible name, so the icons never wrap alone
  const start = within(ticket()).getByRole('button', { name: 'Start' });
  expect(start.className).toContain('min-w-0');
  expect(start.parentElement!.className).toContain('@container');
  expect(within(start).getByText('Start').className).toMatch(/\bhidden\b.*@\[12rem\]:inline/);
  const make = screen.getByRole('button', { name: 'Make ticket from batch #10' });
  expect(make.parentElement!.className).toContain('@container');
  expect(within(make).getByText('Make ticket').className).toMatch(/\bhidden\b.*@\[13rem\]:inline/);
  expect(within(make).getByText('Ticket').className).toMatch(/\bhidden\b.*@\[10\.5rem\]:inline.*@\[13rem\]:hidden/);
  expect(within(ticket()).getByRole('button', { name: 'Timeline' }).parentElement!.className).toContain('flex-wrap');
});

test('board columns keep equal widths, empty or not', () => {
  const state = uiState();
  state.groups.failed = [];
  board(state);
  const full = screen.getByRole('region', { name: /^Needs you/ }), empty = screen.getByRole('region', { name: /^Failed/ });
  expect(full.parentElement!.className).toContain('xl:grid-cols-6');
  expect(full.className).not.toContain('xl:flex-1');
  expect(empty.className).not.toContain('xl:w-40');
});

test('Expand opens a popup with the full ticket, its reasoning, messages and timeline', async () => {
  board();
  const first = ticket();
  expect(within(first).getByText('Source summary').className).toContain('line-clamp-3');
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

test('a batch in triage shows at the top of Needs you before its ticket exists', async () => {
  const state = uiState();
  state.triaging = [{ id: 20, title: 'Fresh request', source: 'teamsrelay', account: 'me@example.invalid', created_at: '2026-11-06T05:58:00.000000Z', job: 'running',
    messages: [{ id: 30, source: 'teamsrelay', sender: 'Colleague', sent_at: '2026-11-06T05:58:00.000000Z', text: 'Can you check the VPN?' }] }];
  board(state);
  const column = screen.getByRole('region', { name: 'Needs you (3)' });
  const card = within(column).getByRole('heading', { name: 'Batch #20: Fresh request' }).closest<HTMLElement>('[data-triage-batch]')!;
  expect(column.querySelector('[data-triage-batch], article')).toBe(card);
  expect(within(card).getByRole('status').textContent).toBe('Triage running');
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

  expect(drag(ticket(2, 'Second proposal'), column('Done today (1)'))).toBe(true);
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
  for (const name of ['Needs you (2)', 'Working (1)', 'Waiting on them (1)', 'Failed (1)', 'Done today (1)', 'Skipped (4)']) expect(screen.getByRole('region', { name })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Skipped (4)' })).getByRole('article', { name: 'Ticket #6: Dismissed work' })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Done today (1)' })).queryByRole('article', { name: 'Ticket #6: Dismissed work' })).toBeNull();
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
  expect(within(working).getByText('North access investigation')).toBeTruthy();
  expect(within(working).getByText('Idle')).toBeTruthy();
});

test('proposed fields, safe refs, expandable literal messages and newest-first detail are visible', async () => {
  const state = uiState();
  state.groups.needs_you[0]!.messages[0]!.text = '<script>globalThis.injected=true</script><img src=x onerror=bad()>';
  state.groups.needs_you[0]!.refs.push({ id: 3, kind: 'jira', key: '<img onerror=bad()>', url: 'javascript:bad()', seen_in: 'message' });
  fetcher.mockResolvedValue(Response.json(uiDetail()));
  board(state);
  const first = ticket();
  for (const value of ['North', 'Confirm access scope', 'Check membership first', '88%', 'Maybe #42', '01_Projects/access.md']) expect(first.textContent).toContain(value);
  expect(within(first).getByText(/Age:/)).toBeTruthy();
  const link = within(first).getByRole('link', { name: 'OPS-123' });
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(within(first).queryByRole('link', { name: '<img onerror=bad()>' })).toBeNull();
  await userEvent.click(within(first).getByRole('button', { name: 'Messages (2)' }));
  expect(within(first).getByText('<script>globalThis.injected=true</script><img src=x onerror=bad()>')).toBeTruthy();
  expect(first.querySelector('script,img')).toBeNull();
  await userEvent.click(within(first).getByRole('button', { name: 'Timeline' }));
  await screen.findByText('Newest timeline event');
  const events = within(first).getByRole('list', { name: 'Timeline events' });
  expect(within(events).getAllByRole('listitem').map((node) => node.textContent)).toEqual([expect.stringContaining('Newest timeline event'), expect.stringContaining('Older timeline event')]);
});

test('labelled note dialog commits exact text, traps focus, ignores shortcuts and restores trigger', async () => {
  const user = userEvent.setup();
  board();
  const trigger = within(ticket()).getByRole('button', { name: 'Open chat with note' });
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Open chat for ticket #1' });
  const field = within(dialog).getByRole('textbox', { name: 'Note (required)' });
  expect(document.activeElement).toBe(field);
  await user.type(field, 'Exact note\nSecond line jskcd/');
  await user.tab({ shift: true });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Approve with note' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetcher).toHaveBeenCalledWith('/api/ticket/1/chat', expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'Exact note\nSecond line jskcd/' }),
    headers: expect.objectContaining({ 'x-dispatcher-token': 'per-start-token', 'content-type': 'application/json' }) }));
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

test('empty required note focuses its field without posting approval', async () => {
  board();
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Open chat with note' }));
  const dialog = screen.getByRole('dialog', { name: 'Open chat for ticket #1' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Approve with note' }));
  expect(within(dialog).getByRole('alert').textContent).toBe('Note is required');
  expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Note (required)' }));
  expect(fetcher).not.toHaveBeenCalled();
});

test('dialog close uses search fallback when committed refresh removes its trigger card', async () => {
  const changed = uiState();
  changed.groups.needs_you = changed.groups.needs_you.filter((item) => item.id !== 1);
  fetcher.mockImplementation(async (_input: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { ticket: 1 } : changed));
  board();
  await userEvent.click(within(ticket()).getByRole('button', { name: 'Open chat with note' }));
  const dialog = screen.getByRole('dialog', { name: 'Open chat for ticket #1' });
  await userEvent.type(within(dialog).getByRole('textbox'), 'Exact note');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Approve with note' }));
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
  expect((within(mute).getByRole('combobox', { name: 'Mute for' }) as HTMLSelectElement).value).toBe('24');
  await userEvent.selectOptions(within(mute).getByRole('combobox', { name: 'Mute for' }), '168');
  await userEvent.click(within(mute).getByRole('button', { name: 'Mute chat' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetcher).toHaveBeenCalledWith('/api/batch/10/mute', expect.objectContaining({ method: 'POST', body: JSON.stringify({ hours: 168 }) }));

  await userEvent.click(within(ticket()).getByRole('button', { name: 'Dismiss' }));
  const dismiss = screen.getByRole('dialog', { name: 'Dismiss ticket #1' });
  await userEvent.selectOptions(within(dismiss).getByRole('combobox', { name: 'Mute this chat' }), 'always');
  await userEvent.click(within(dismiss).getByRole('button', { name: 'Confirm dismiss' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetcher).toHaveBeenCalledWith('/api/ticket/1/dismiss', expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: '', mute_hours: null }) }));

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
  expect(screen.getByRole('dialog', { name: 'Open chat for ticket #1' })).toBeTruthy();
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
  changed.groups.needs_you[0]!.proposal = 'Refreshed proposal';
  fetcher.mockImplementation(async (input: string) => Response.json(input.includes('/api/ticket/') ? uiDetail() : changed, { headers: { etag: '"new"' } }));
  const tick = interval.mock.calls.find(([, delay]) => delay === 10_000)![0] as () => void;
  await act(async () => tick());
  expect(within(original).getByText('Refreshed proposal')).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Select ticket #1' }).getAttribute('aria-checked')).toBe('true');
  expect(within(original).getByText('Newest source message')).toBeTruthy();
  expect(within(original).getByText('Newest timeline event')).toBeTruthy();
  expect(document.activeElement).toBe(original);
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
  expect(screen.queryByRole('button', { name: 'Open chat with note' })).toBeNull();
});
