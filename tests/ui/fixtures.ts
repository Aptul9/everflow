import type { OverviewState, TicketCard, TicketDetail } from '../../src/lib/web-types.ts';

export const AT = '2026-11-06T06:00:00.000000Z';
export function card(id: number, fields: Partial<TicketCard> = {}): TicketCard {
  return { id, title: 'Reset access', client: 'North', lifecycle: 'proposed', stage: 'Needs you', summary: 'Source summary', ask: 'Confirm access scope',
    proposal: 'Check membership first', confidence: 0.88, maybe_ticket: 42, kb_notes: ['01_Projects/access.md'], created_at: AT, last_activity_at: AT,
    closed_at: null, report: null, report_line: null, session_id: null, chat_running: false, asking: null, chat_waiting_since: null, origin: null, session_title: null, reason: 'Same issue as the open access request', why: null, dismissed_by: null, restorable: false, timeline_revision: 'synthetic-initial-timeline',
    refs: [{ id: 2, kind: 'jira', key: 'OPS-123', url: 'https://example.invalid/browse/OPS-123', seen_in: 'message' }],
    messages: [{ id: 2, source: 'outlook', sender: 'Third party', sent_at: AT, text: 'Newest source message', attachments: [] },
      { id: 1, source: 'teams', sender: 'Another sender', sent_at: '2026-11-05T06:00:00Z', text: 'Older source message', attachments: [] }], ...fields };
}

export function uiState(): OverviewState {
  return {
    tickets_enabled: true, chats_enabled: true, day: '2026-11-06', initiatives: {},
    groups: {
      needs_you: [card(1), card(2, { title: 'Second proposal' })],
      working: [card(3, { title: 'Active work', lifecycle: 'active', stage: 'Idle', report: 'working', report_line: 'Membership checked', session_title: 'North access investigation' })],
      waiting_them: [card(4, { title: 'Vendor reply', lifecycle: 'active', stage: 'Waiting on them' })],
      failed: [card(5, { title: 'Failed work', lifecycle: 'active', stage: 'Failed' })],
      done_today: [card(7, { title: 'Closed work', lifecycle: 'done', stage: 'Done', closed_at: AT })],
      skipped: [card(6, { title: 'Dismissed work', lifecycle: 'dismissed', stage: 'Dismissed', closed_at: AT })],
    },
    skipped: [
      { id: 10, title: 'Skipped source', outcome: 'not_on_us', source: 'outlook', account: 'test@example.invalid', created_at: AT, reason: 'Greeting only, nothing to do', messages: [] },
      { id: 11, title: 'Backlog source', outcome: 'backlog', source: 'teams', account: 'test@example.invalid', created_at: AT, reason: null, messages: [] },
      { id: 12, title: 'Answered source', outcome: 'answered', source: 'teams', account: 'test@example.invalid', created_at: AT, reason: null, messages: [] },
    ],
    triaging: [],
    agents: [],
    models: { triage: { model: 'first/claude-haiku-5-5', effort: null, default_model: 'first/claude-haiku-5-5', overridden: false },
      chat: { model: 'meridian-auto/claude-opus-5-5', effort: null, default_model: 'meridian-auto/claude-opus-5-5', overridden: false },
      // Fresh lists, so the page does not ask the daemon for new ones in unrelated tests
      options: { chat: [], accounts: {}, at: new Date(Date.now() + 86_400_000).toISOString(), error: null, requested_at: null },
      triage_routes: ['first'] },
    chat_project: 'Vault',
    muted: [],
    health: [
      { dependency: 'daemon', scope: 'daemon', state: 'ok', since: AT, last_ok: AT, last_error: null },
      { dependency: 'teams', scope: 'source', state: 'failing', since: AT, last_ok: null, last_error: 'Source unavailable' },
      { dependency: 'opencode', scope: 'openchamber', state: 'unknown', since: null, last_ok: null, last_error: null },
    ],
    problems: {
      jobs: [{ id: 77, ticket: null, kind: 'triage', last_error: 'Parse failed', updated_at: AT, raw: '<bad-output>', parse_error: 'Expected JSON object' }],
      quarantine: [{ id: 8, source: 'relay', line: '<quarantined>', error: 'Invalid record', at: AT, truncated: false }],
      triage: [{ id: 9, batch: 10, at: AT, raw: 'raw invalid response', parse_error: 'Unexpected token' }],
    },
    feedback: { dismiss_count: 4, make_ticket_count: 2, dismiss_reasons: [{ ticket: 90, reason: 'Duplicate', at: AT }] },
  };
}

export function uiDetail(): TicketDetail {
  return { ticket: card(1), refs: card(1).refs, messages: card(1).messages,
    timeline: [{ id: 20, at: AT, actor: 'agent', kind: 'triage', body: 'Newest timeline event', link: null },
      { id: 10, at: '2026-11-05T06:00:00Z', actor: 'source', kind: 'message', body: 'Older timeline event', link: null }] };
}
