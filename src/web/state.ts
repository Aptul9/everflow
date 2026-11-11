import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../dispatcher/config.ts';
import { chatDirectory, clientsFor, sourceAccounts, sourceEnabled } from '../dispatcher/policy.ts';
import { batchClients, batchMessages, batchPaused, detail, feedback, MUTE_FOREVER, pausedInputs } from '../dispatcher/tickets.ts';
import type { Message } from '../dispatcher/tickets.ts';
import { modelChoice, readModelOptions } from '../dispatcher/settings.ts';
import { calendarDay, utc } from '../dispatcher/time.ts';
import type { Health, OverviewState, Reference, SkippedBatch, SourceMessage, TicketCard, TicketDetail, TriageBatch } from '../lib/web-types.ts';

export { calendarDay };

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
    report_line: row.report_line, session_id: row.session_id, chat_running: !!row.chat_running_at, session_title: row.session_title, reason: timeline.find((event) => event.kind === 'triage')?.body ?? null,
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
  const paused = pausedInputs(db);
  const waiting = new Map(db.prepare(`SELECT c.source||':'||lower(c.account) AS input,COUNT(*) AS n FROM batch b JOIN conversation c ON c.id=b.conversation
    WHERE b.state='pending' AND b.outcome IN ('pending','triage','routed') GROUP BY input`).all().map((row) => [String(row.input), Number(row.n)]));
  for (const account of db.prepare(`SELECT source,account FROM conversation UNION SELECT source,account FROM cursor WHERE account<>'*' ORDER BY source,account`).all()) {
    const dependency = `${account.source}:${account.account}`;
    const key = `${account.source}:${String(account.account).toLowerCase()}`;
    const checkpoint = db.prepare('SELECT since FROM cursor WHERE source=? AND account=?').get(account.source!, account.account!);
    const row = result.get(dependency);
    const source = result.get(String(account.source));
    const allowed = sourceAccounts(cfg, String(account.source));
    const off = !sourceEnabled(cfg, String(account.source)) || allowed && !allowed.has(String(account.account).toLowerCase());
    result.set(dependency, { ...(row ?? { dependency, scope: 'account', state: 'unknown', since: null, last_ok: null, last_error: null }),
      ...(off ? { state: 'disabled' as const } : {}),
      ...(source?.coverage ? { coverage: source.coverage } : {}),
      checkpoint: checkpoint ? String(checkpoint.since) : null,
      paused: paused.has(key), waiting: paused.has(key) ? waiting.get(key) ?? 0 : 0, clients: clientsFor(cfg, String(account.account), []) });
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
  const cleared = new Set(db.prepare('SELECT id FROM ticket WHERE cleared_at IS NOT NULL').all().map((row) => Number(row.id)));
  // Finished cards and skipped batches leave the board one day after they finished
  const shownSince = utc(new Date(at.getTime() - 86_400_000).toISOString());
  for (const ticket of tickets) {
    if (ticket.lifecycle === 'done' || ticket.lifecycle === 'dismissed') {
      if (ticket.closed_at && utc(ticket.closed_at) >= shownSince && !cleared.has(ticket.id)) groups[ticket.lifecycle === 'dismissed' ? 'skipped' : 'done_today'].push(ticket);
    } else if (ticket.stage === 'Failed') groups.failed.push(ticket);
    else if (ticket.stage === 'Needs you') groups.needs_you.push(ticket);
    else if (ticket.stage === 'Waiting on them') groups.waiting_them.push(ticket);
    else groups.working.push(ticket);
  }
  const skipped = db.prepare(`SELECT b.id,c.title,c.source,c.account,b.outcome,b.created_at,
    (SELECT t.reason FROM triage_log t WHERE t.batch=b.id ORDER BY t.id DESC LIMIT 1) AS reason FROM batch b JOIN conversation c ON c.id=b.conversation
    WHERE b.outcome IN ('not_on_us','backlog','answered','muted') AND b.cleared_at IS NULL AND COALESCE(b.done_at,b.created_at)>=?
    ORDER BY b.created_at DESC,b.id DESC`).all(shownSince).map((row) => ({
    id: Number(row.id), title: row.title as string | null, source: String(row.source), account: String(row.account),
    outcome: row.outcome as SkippedBatch['outcome'], created_at: String(row.created_at), reason: row.reason as string | null,
    messages: batchMessages(db, Number(row.id)).reverse().map(message),
  }));
  const paused = pausedInputs(db);
  const triaging = db.prepare(`SELECT b.id,c.title,c.source,c.account,b.created_at,
    (SELECT j.state FROM job j WHERE j.kind='triage' AND json_extract(j.payload,'$.batch')=b.id AND j.state IN ('queued','running','parked') ORDER BY j.id DESC LIMIT 1) AS job
    FROM batch b JOIN conversation c ON c.id=b.conversation
    WHERE b.state='pending' AND b.ticket IS NULL AND b.outcome IN ('pending','triage') ORDER BY b.created_at DESC,b.id DESC`).all().map((row) => ({
    id: Number(row.id), title: row.title as string | null, source: String(row.source), account: String(row.account), created_at: String(row.created_at),
    job: row.job as TriageBatch['job'], clients: batchClients(db, cfg, Number(row.id)), held: !row.job && batchPaused(db, Number(row.id), paused),
    messages: batchMessages(db, Number(row.id)).reverse().map(message),
  }));
  const agents: OverviewState['agents'] = [
    ...triaging.filter((batch) => batch.job === 'running').map((batch) => ({ kind: 'triage' as const, clients: batch.clients, title: batch.title, ticket: null })),
    ...tickets.filter((ticket) => ticket.chat_running && ticket.lifecycle === 'active').map((ticket) => ({ kind: 'chat' as const,
      clients: ticket.client ? [ticket.client] : [], title: ticket.title, ticket: ticket.id })),
  ];
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
  const triage = db.prepare(`SELECT id,batch,at,reason,raw FROM triage_log t WHERE action='invalid'
    AND NOT EXISTS (SELECT 1 FROM triage_log v WHERE v.batch=t.batch AND v.id>t.id AND v.action IN ('new','update','skip')) ORDER BY at DESC,id DESC`).all()
    .map((row) => ({ id: Number(row.id), batch: row.batch === null ? null : Number(row.batch), at: String(row.at),
      raw: row.raw as string | null, parse_error: row.reason as string | null }));
  return { tickets_enabled: cfg.tickets.enabled === true, chats_enabled: cfg.chats.enabled === true, day, groups, skipped, triaging, agents,
    models: { triage: modelChoice(db, cfg, 'triage'), chat: modelChoice(db, cfg, 'chat'), options: readModelOptions(db) }, chat_project: basename(cfg.opencode.directory || ''),
    chat_projects: Object.fromEntries(Object.keys(cfg.clients).map((client) => [client, basename(chatDirectory(cfg, client))])), muted,
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
