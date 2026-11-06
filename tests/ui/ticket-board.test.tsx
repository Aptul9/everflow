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

test('six tabs have counts; health, Problems and persisted feedback remain outside tabs', async () => {
  board();
  expect(screen.getAllByRole('tab')).toHaveLength(6);
  for (const name of ['Needs you (2)', 'Working (1)', 'Waiting on them (1)', 'Failed (1)', 'Done today (1)', 'Skipped (3)']) expect(screen.getByRole('tab', { name })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Health' }).textContent).toContain('Source unavailable');
  expect(screen.getByRole('region', { name: 'Health' }).textContent).toContain('OpenChamber');
  const problems = screen.getByRole('region', { name: 'Problems' });
  expect(problems.textContent).toContain('Unbound job #77');
  expect(problems.textContent).toContain('Expected JSON object');
  expect(problems.textContent).toContain('<bad-output>');
  expect(problems.textContent).toContain('raw invalid response');
  expect(problems.textContent).toContain('<quarantined>');
  expect(screen.getByText('Dismissed: 4. Made tickets: 2.')).toBeTruthy();
  await userEvent.click(screen.getByRole('tab', { name: 'Working (1)' }));
  expect(problems.closest('[role="tabpanel"]')).toBeNull();
  expect(screen.getByText('Membership checked')).toBeTruthy();
  expect(screen.getByText('North access investigation')).toBeTruthy();
  expect(screen.getByText('Idle')).toBeTruthy();
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
  await userEvent.click(screen.getByRole('tab', { name: 'Skipped (3)' }));
  for (const id of [10, 11, 12]) {
    await userEvent.click(screen.getByRole('button', { name: `Make ticket from batch #${id}` }));
    expect(fetcher).toHaveBeenCalledWith(`/api/batch/${id}/ticket`, expect.objectContaining({ method: 'POST', body: '{}' }));
  }
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
  await userEvent.click(screen.getByRole('tab', { name: 'Working (1)' }));
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
