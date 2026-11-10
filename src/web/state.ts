import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../dispatcher/config.ts';
import { sourceAccounts, sourceEnabled } from '../dispatcher/policy.ts';
import { batchMessages, detail, feedback, MUTE_FOREVER } from '../dispatcher/tickets.ts';
import type { Message } from '../dispatcher/tickets.ts';
import { utc } from '../dispatcher/time.ts';
import type { Health, OverviewState, Reference, SkippedBatch, SourceMessage, TicketCard, TicketDetail } from '../lib/web-types.ts';

export function calendarDay(at: string | Date): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function message(row: Message): SourceMessage {
  let deleted = false;
  try { deleted = JSON.parse(row.ref ?? '{}').deleted === true; } catch { /* Source metadata is not executable. */ }
  return { id: row.id, source: row.source, sender: row.sender_name || row.sender, sent_at: row.sent_at,
    text: deleted ? '[Source message deleted]' : row.text };
}

export function ticketDetail(db: DatabaseSync, id: number): TicketDetail {
  const view = detail(db, id);
  const row = view.ticket;
  const messages = view.messages.map(message);
  const timeline = view.timeline.map(({ id, at, kind, actor, body, link }) => ({ id, at, kind, actor, body, link }));
  const refs = (view.refs as unknown as (Reference & { ticket: number })[]).map(({ id, kind, key, url, seen_in }) => ({ id, kind, key, url, seen_in }))
    .sort((a, b) => b.id - a.id);
  const ticket: TicketCard = { id: row.id, title: row.title, client: row.client, lifecycle: row.lifecycle,
    stage: row.lifecycle === 'dismissed' ? 'Dismissed' : row.lifecycle === 'done' ? 'Done' : view.stage,
    summary: row.summary, ask: row.ask, proposal: row.proposal, confidence: row.confidence, maybe_ticket: row.maybe_ticket,
    kb_notes: (JSON.parse(row.kb_notes) as unknown[]).filter((value): value is string => typeof value === 'string'),
    created_at: row.created_at, last_activity_at: row.last_activity_at, closed_at: row.closed_at, report: row.report,
    report_line: row.report_line, session_title: row.session_title, reason: timeline.find((event) => event.kind === 'triage')?.body ?? null,
    timeline_revision: representation(timeline).etag, messages, refs };
  return { ticket, messages, refs, timeline };
}

function health(db: DatabaseSync, cfg: Config): Health[] {
  const saved = db.prepare('SELECT dependency,state,since,last_ok,last_error,detail FROM health ORDER BY dependency').all();
  const result = new Map<string, Health>();
  const sources = new Set([...Object.keys(cfg.windows), ...db.prepare('SELECT DISTINCT source FROM conversation ORDER BY source').all().map((row) => String(row.source))]);
  const scope = (name: string): Health['scope'] => name === 'daemon' ? 'daemon' : name.startsWith('provider:') ? 'provider'
    : name === 'opencode' || name.startsWith('opencode:') ? 'openchamber' : sources.has(name) ? 'source' : name.startsWith('jobs:') ? 'jobs' : 'account';
  for (const dependency of ['daemon', 'opencode', ...sources, ...cfg.triage.providers.map((id) => `provider:${id}`)]) {
    result.set(dependency, { dependency, scope: scope(dependency), state: 'unknown', since: null, last_ok: null, last_error: null });
  }
  for (const row of saved) {
    const detail = JSON.parse(String(row.detail ?? '{}')) as Record<string, unknown>;
    const coverage = detail.coverage === 'recent-topics' || detail.coverage === 'saved-history-replay' ? detail.coverage : undefined;
    result.set(String(row.dependency), { dependency: String(row.dependency), scope: scope(String(row.dependency)),
      state: row.state as Health['state'], since: row.since as string, last_ok: row.last_ok as string | null, last_error: row.last_error as string | null,
      ...(coverage ? { coverage } : {}), ...(typeof detail.observed_at === 'string' ? { observed_at: detail.observed_at } : {}) });
  }
  for (const source of sources) {
    if (!sourceEnabled(cfg, source)) result.set(source, { ...result.get(source)!, state: 'disabled' });
  }
  for (const account of db.prepare(`SELECT source,account FROM conversation UNION SELECT source,account FROM cursor WHERE account<>'*' ORDER BY source,account`).all()) {
    const dependency = `${account.source}:${account.account}`;
    const checkpoint = db.prepare('SELECT since FROM cursor WHERE source=? AND account=?').get(account.source!, account.account!);
    const row = result.get(dependency);
    const source = result.get(String(account.source));
    const allowed = sourceAccounts(cfg, String(account.source));
    const off = !sourceEnabled(cfg, String(account.source)) || allowed && !allowed.has(String(account.account).toLowerCase());
    result.set(dependency, { ...(row ?? { dependency, scope: 'account', state: 'unknown', since: null, last_ok: null, last_error: null }),
      ...(off ? { state: 'disabled' as const } : {}),
      ...(source?.coverage ? { coverage: source.coverage } : {}),
      checkpoint: checkpoint ? String(checkpoint.since) : null });
  }
  if (!cfg.tickets.enabled) result.set('tickets', { dependency: 'tickets', scope: 'jobs', state: 'disabled', since: null, last_ok: null, last_error: null });
  return [...result.values()].sort((a, b) => a.dependency.localeCompare(b.dependency));
}

export function readState(db: DatabaseSync, cfg: Config, at = new Date()): OverviewState {
  const day = calendarDay(at);
  const groups: OverviewState['groups'] = { needs_you: [], working: [], waiting_them: [], failed: [], done_today: [], skipped: [] };
  const tickets = db.prepare('SELECT id FROM ticket ORDER BY id').all().map((row) => ticketDetail(db, Number(row.id)).ticket)
    .sort((a, b) => Number(b.lifecycle === 'proposed') - Number(a.lifecycle === 'proposed')
      || utc(b.last_activity_at ?? b.created_at).localeCompare(utc(a.last_activity_at ?? a.created_at)) || b.id - a.id);
  for (const ticket of tickets) {
    if (ticket.lifecycle === 'done' || ticket.lifecycle === 'dismissed') {
      if (ticket.closed_at && calendarDay(ticket.closed_at) === day) groups[ticket.lifecycle === 'dismissed' ? 'skipped' : 'done_today'].push(ticket);
    } else if (ticket.stage === 'Failed') groups.failed.push(ticket);
    else if (ticket.stage === 'Needs you') groups.needs_you.push(ticket);
    else if (ticket.stage === 'Waiting on them') groups.waiting_them.push(ticket);
    else groups.working.push(ticket);
  }
  const skipped = db.prepare(`SELECT b.id,c.title,c.source,c.account,b.outcome,b.created_at FROM batch b JOIN conversation c ON c.id=b.conversation
    WHERE b.outcome IN ('not_on_us','backlog','answered','muted') AND b.cleared_at IS NULL ORDER BY b.created_at DESC,b.id DESC`).all().map((row) => ({
    id: Number(row.id), title: row.title as string | null, source: String(row.source), account: String(row.account),
    outcome: row.outcome as SkippedBatch['outcome'], created_at: String(row.created_at),
    messages: batchMessages(db, Number(row.id)).reverse().map(message),
  }));
  const muted = db.prepare('SELECT id,title,source,account,muted_until FROM conversation WHERE muted_until > ? ORDER BY muted_until,id').all(utc(at.toISOString()))
    .map((row) => ({ id: Number(row.id), title: row.title as string | null, source: String(row.source), account: String(row.account),
      until: String(row.muted_until), forever: row.muted_until === MUTE_FOREVER }));
  const jobs = db.prepare("SELECT id,kind,ticket,last_error,updated_at,payload FROM job WHERE state='parked' ORDER BY updated_at DESC,id DESC").all().map((row) => {
    const evidence = (JSON.parse(String(row.payload)) as { assessment_error?: { raw?: unknown; parse_error?: unknown } }).assessment_error;
    return { id: Number(row.id), kind: String(row.kind), ticket: row.ticket === null ? null : Number(row.ticket),
      last_error: row.last_error as string | null, updated_at: String(row.updated_at), raw: typeof evidence?.raw === 'string' ? evidence.raw : null,
      parse_error: typeof evidence?.parse_error === 'string' ? evidence.parse_error : null };
  });
  const quarantine = db.prepare('SELECT id,source,line,error,at,truncated FROM quarantine WHERE replayed_at IS NULL ORDER BY at DESC,id DESC').all()
    .map((row) => ({ id: Number(row.id), source: String(row.source), line: String(row.line), error: String(row.error), at: String(row.at), truncated: row.truncated === 1 }));
  const triage = db.prepare("SELECT id,batch,at,reason,raw FROM triage_log WHERE action='invalid' ORDER BY at DESC,id DESC").all()
    .map((row) => ({ id: Number(row.id), batch: row.batch === null ? null : Number(row.batch), at: String(row.at),
      raw: row.raw as string | null, parse_error: row.reason as string | null }));
  return { tickets_enabled: cfg.tickets.enabled === true, chats_enabled: cfg.chats.enabled === true, day, groups, skipped, muted,
    health: health(db, cfg), problems: { jobs, quarantine, triage }, feedback: feedback(db) };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

export function representation(value: unknown): { json: string; etag: string } {
  const json = canonicalJson(value);
  return { json, etag: `"${createHash('sha256').update(json).digest('hex')}"` };
}
