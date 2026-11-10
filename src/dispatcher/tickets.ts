import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { clientsFor, isNotePath } from './policy.ts';
import type { Config } from './config.ts';
import { transaction } from './db.ts';
import type { Job } from './jobs.ts';
import { utc } from './time.ts';
import type { Lifecycle, Report } from './types.ts';

export type Stage = 'Failed' | 'Needs you' | 'Working' | 'Waiting on them' | 'Idle' | 'Done' | 'Dismissed';

export class TicketError extends Error {
  constructor(readonly code: 'ticket.not-found' | 'ticket.conflict' | 'ticket.invalid-decision' | 'ticket.invalid-input', message: string) {
    super(message);
  }
}

export interface Ticket {
  id: number;
  title: string;
  client: string | null;
  summary: string;
  ask: string;
  proposal: string;
  lifecycle: Lifecycle;
  session_id: string | null;
  approved_at: string | null;
  closed_at: string | null;
  created_at: string;
  last_activity_at: string | null;
  report: Report | null;
  report_at: string | null;
  report_line: string | null;
  report_message_id: string | null;
  report_turn: number | null;
  kb_notes: string;
  confidence: number | null;
  approval_note: string | null;
  archived_at: string | null;
  session_title: string | null;
  maybe_ticket: number | null;
  merged_into: number | null;
  // Set by sync while the bound session runs a turn, null once it is idle
  chat_running_at?: string | null;
}

export interface Message {
  id: number;
  source: string;
  message_id: string;
  native_id: string | null;
  conversation: number;
  person: number | null;
  sender: string | null;
  sender_name: string | null;
  sender_is_me: number;
  sent_at: string;
  stored_at: string;
  text: string | null;
  attachments: string | null;
  ref: string | null;
  batch: number | null;
}

interface Batch {
  id: number;
  conversation: number;
  state: string;
  outcome: string | null;
  ticket: number | null;
  created_at: string;
  source: string;
  account: string;
  title: string | null;
}

interface TimelineEvent {
  id: number;
  ticket: number;
  at: string;
  kind: 'message' | 'triage' | 'ref' | 'status' | 'comment' | 'approval' | 'chat' | 'failure' | 'merge';
  actor: string;
  body: string;
  link: string | null;
  event_key: string;
}

function getTicket(db: DatabaseSync, id: number): Ticket {
  validId(id, 'ticket');
  const row = db.prepare('SELECT * FROM ticket WHERE id=?').get(id);
  if (!row) throw new TicketError('ticket.not-found', `Ticket ${id} not found`);
  return row as unknown as Ticket;
}

function getBatch(db: DatabaseSync, id: number): Batch {
  validId(id, 'batch');
  const row = db.prepare('SELECT b.*,c.source,c.account,c.title FROM batch b JOIN conversation c ON c.id=b.conversation WHERE b.id=?').get(id);
  if (!row) throw new TicketError('ticket.not-found', `Batch ${id} not found`);
  return row as unknown as Batch;
}

function history(db: DatabaseSync, ticket: number, at: string, kind: TimelineEvent['kind'], actor: string, body: string, key: string, link: string | null = null): boolean {
  return db.prepare('INSERT INTO timeline(ticket,at,kind,actor,body,link,event_key) VALUES (?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING')
    .run(ticket, at, kind, actor, body, link, key).changes !== 0;
}

function daysBefore(at: string, days: number): string {
  return new Date(Date.parse(at) - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, at.slice(19));
}

export function batchMessages(db: DatabaseSync, batch: number): Message[] {
  return (db.prepare('SELECT * FROM message WHERE batch=?').all(batch) as unknown as Message[])
    .sort((a, b) => utc(a.sent_at).localeCompare(utc(b.sent_at)) || a.id - b.id);
}

// Earlier batched messages of the conversation, newest `limit` returned oldest first, so triage can judge age and replies.
export function conversationHistory(db: DatabaseSync, conversation: number, batch: number, limit: number) {
  return (db.prepare('SELECT * FROM message WHERE conversation=? AND batch IS NOT NULL AND batch<>? ORDER BY sent_at DESC,id DESC LIMIT ?')
    .all(conversation, batch, limit) as unknown as Message[]).reverse().map((message) => ({
    id: message.id, sent_at: message.sent_at, sender: message.sender, sender_name: message.sender_name, sender_is_me: !!message.sender_is_me,
    text: JSON.parse(message.ref ?? '{}').deleted === true ? '[Source message deleted]' : message.text?.slice(0, 2_000) ?? null,
  }));
}

function batchRefs(db: DatabaseSync, batch: Batch): TicketRef[] {
  return extractRefs([batch.title ?? '', ...batchMessages(db, batch.id).map((message) => message.text ?? '')].join('\n'), 'message');
}

function inputAt(db: DatabaseSync, batch: Batch, target: number): string {
  const stamps = batchMessages(db, batch.id).map((message) => utc(message.stored_at));
  const intents = db.prepare('SELECT at FROM timeline WHERE ticket=? AND (event_key=? OR event_key GLOB ?)')
    .all(target, `make-ticket:batch:${batch.id}`, `correction:batch:${batch.id}:ticket:${target}:*`);
  stamps.push(...intents.map((intent) => utc(String(intent.at))));
  return stamps.sort().at(-1) ?? utc(batch.created_at);
}

function messageVersion(message: Message): string {
  return createHash('sha256').update(JSON.stringify([message.id, message.sender, message.sender_name, message.sender_is_me,
    message.sent_at, message.text, message.attachments, message.ref, message.stored_at])).digest('hex');
}

export function stage(db: DatabaseSync, ticket: number, projection: { exclude_job?: number; exclude_turn?: number; report?: Report | null; lifecycle?: Lifecycle; pending?: boolean } = {}): Stage {
  const row = { ...getTicket(db, ticket), ...(projection.report !== undefined ? { report: projection.report } : {}),
    ...(projection.lifecycle ? { lifecycle: projection.lifecycle } : {}) };
  if (db.prepare("SELECT 1 FROM job WHERE ticket=? AND state='parked' AND id<>?").get(ticket, projection.exclude_job ?? -1)) return 'Failed';
  if (row.lifecycle === 'active' && row.chat_running_at && projection.report === undefined) return 'Working';
  if (row.lifecycle === 'proposed' || row.report === 'needs_you' || row.report === 'blocked') return 'Needs you';
  if (projection.pending || db.prepare("SELECT 1 FROM job WHERE ticket=? AND state IN ('queued','running') AND id<>? AND kind NOT IN ('sync','archive','purge')").get(ticket, projection.exclude_job ?? -1)
    || db.prepare("SELECT 1 FROM turn WHERE ticket=? AND state IN ('prepared','admitted','running') AND id<>?").get(ticket, projection.exclude_turn ?? -1)) return 'Working';
  if (row.report === 'waiting_them') return 'Waiting on them';
  if (row.lifecycle === 'active') return 'Idle';
  return row.lifecycle === 'done' ? 'Done' : 'Dismissed';
}

export function detail(db: DatabaseSync, ticket: number) {
  const owner = getTicket(db, ticket);
  const timeline = (db.prepare('SELECT * FROM timeline WHERE ticket=?').all(ticket) as unknown as TimelineEvent[])
    .sort((a, b) => utc(b.at).localeCompare(utc(a.at)) || b.id - a.id);
  const messages = (db.prepare(`SELECT DISTINCT m.* FROM message m LEFT JOIN ticket_conversation l ON l.conversation=m.conversation
    LEFT JOIN batch b ON b.id=m.batch WHERE l.ticket=? OR b.ticket=?`).all(ticket, ticket) as unknown as Message[])
    .sort((a, b) => utc(b.sent_at).localeCompare(utc(a.sent_at)) || b.id - a.id);
  return { ticket: owner, stage: stage(db, ticket), timeline, messages,
    refs: db.prepare('SELECT * FROM ticket_ref WHERE ticket=? ORDER BY kind,key,id').all(ticket),
    conversations: db.prepare('SELECT c.*,l.kind,l."by" FROM ticket_conversation l JOIN conversation c ON c.id=l.conversation WHERE l.ticket=? ORDER BY c.id').all(ticket),
    turns: db.prepare('SELECT * FROM turn WHERE ticket=? ORDER BY id DESC').all(ticket) };
}

export function batchClients(db: DatabaseSync, cfg: Pick<Config, 'clients'>, batch: number): string[] {
  const row = getBatch(db, batch);
  const messages = batchMessages(db, batch);
  const text = [row.title ?? '', ...messages.flatMap((message) => [message.sender ?? '', message.text ?? ''])].join('\n');
  const addresses = [...text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((value) => value[0]);
  return clientsFor(cfg, row.account, addresses);
}

function refMatches(db: DatabaseSync, refs: readonly TicketRef[]): number[] {
  const matches = new Set<number>();
  for (const ref of refs) {
    for (const row of db.prepare(`SELECT r.ticket FROM ticket_ref r JOIN ticket t ON t.id=r.ticket
      WHERE r.kind=? AND r.key=? AND t.lifecycle IN ('proposed','active')`).all(ref.kind, ref.key)) matches.add(Number(row.ticket));
  }
  return [...matches].sort((a, b) => a - b);
}

export interface Candidate {
  id: number;
  title: string;
  client: string | null;
  lifecycle: Lifecycle;
  summary: string;
  shared_people: boolean;
  shared_ref: boolean;
  same_client: boolean;
  recent: boolean;
}

export function candidates(db: DatabaseSync, cfg: Config, batch: number, at?: string): Candidate[] {
  const row = getBatch(db, batch);
  const clients = batchClients(db, cfg, batch);
  const references = new Set(refMatches(db, batchRefs(db, row)));
  const shared = new Set<number>();
  for (const message of batchMessages(db, batch).filter((message) => message.person !== null && !message.sender_is_me)) {
    for (const match of db.prepare(`SELECT DISTINCT l.ticket FROM message m JOIN ticket_conversation l ON l.conversation=m.conversation
      WHERE m.person=? AND m.source=? AND m.sender_is_me=0`).all(message.person, message.source)) shared.add(Number(match.ticket));
  }
  const cutoff = daysBefore(utc(at), cfg.jobs.reopen_days);
  return (db.prepare('SELECT * FROM ticket ORDER BY id').all() as unknown as Ticket[]).flatMap((ticket) => {
    const open = ticket.lifecycle === 'proposed' || ticket.lifecycle === 'active';
    const sameClient = open && (ticket.client === null ? clients.length === 0 : clients.includes(ticket.client));
    const recent = [ticket.created_at, ticket.last_activity_at, ticket.closed_at].some((stamp) => stamp !== null && utc(stamp) >= cutoff);
    if (!sameClient && !recent && !shared.has(ticket.id) && !references.has(ticket.id)) return [];
    return [{ id: ticket.id, title: ticket.title, client: ticket.client, lifecycle: ticket.lifecycle, summary: ticket.summary,
      shared_people: shared.has(ticket.id), shared_ref: references.has(ticket.id), same_client: sameClient, recent }];
  }).sort((a, b) => Number(b.shared_ref) - Number(a.shared_ref) || Number(b.shared_people) - Number(a.shared_people) || a.id - b.id);
}

export interface Route {
  ticket: number | null;
  mode: 'new' | 'update' | 'forward' | 'closed';
  candidates: number[];
  context: number[];
}

export function attachBatch(db: DatabaseSync, batch: number, ticket: number, at?: string): void {
  transaction(db, () => {
    const now = utc(at);
    const row = getBatch(db, batch);
    const owner = getTicket(db, ticket);
    let changed = false;
    db.prepare('UPDATE batch SET ticket=? WHERE id=?').run(ticket, batch);
    for (const message of batchMessages(db, batch)) {
      const deleted = JSON.parse(message.ref ?? '{}').deleted === true;
      changed = history(db, ticket, now, 'message', message.sender_is_me ? 'you' : message.sender_name || message.sender || message.source,
        deleted ? '[Source message deleted]' : message.text ?? '', `message:${ticket}:${message.id}:${messageVersion(message)}`) || changed;
    }
    addRefs(db, ticket, batchRefs(db, row), now);
    if (changed && (!owner.last_activity_at || utc(owner.last_activity_at) < now)) db.prepare('UPDATE ticket SET last_activity_at=? WHERE id=?').run(now, ticket);
  });
}

export function route(db: DatabaseSync, batch: number, at?: string, reopenDays = 14): Route {
  return transaction(db, () => {
    const now = utc(at);
    const row = getBatch(db, batch);
    const linked = db.prepare("SELECT ticket FROM ticket_conversation WHERE conversation=? AND kind IN ('primary','linked')").get(row.conversation);
    let owner = linked ? getTicket(db, Number(linked.ticket)) : null;
    if (owner?.closed_at && inputAt(db, row, owner.id) <= utc(owner.closed_at) && !owner.merged_into) {
      db.prepare("UPDATE batch SET ticket=?,state='done',outcome='closed',done_at=? WHERE id=?").run(owner.id, now, batch);
      const context = db.prepare("SELECT ticket FROM ticket_conversation WHERE conversation=? AND kind='context' ORDER BY ticket").all(row.conversation).map((link) => Number(link.ticket));
      return { ticket: owner.id, mode: 'closed', candidates: [], context };
    }
    if (owner && (owner.lifecycle === 'done' || owner.lifecycle === 'dismissed')) {
      if (owner.lifecycle === 'done' && !owner.merged_into && owner.closed_at && utc(owner.closed_at) >= daysBefore(now, reopenDays)) {
        db.prepare('UPDATE ticket SET lifecycle=?,report=NULL,last_activity_at=? WHERE id=?').run(owner.approved_at ? 'active' : 'proposed', now, owner.id);
        history(db, owner.id, now, 'status', 'rule', 'Reopened by new source input', `reopen:${owner.id}:batch:${batch}`);
        owner = getTicket(db, owner.id);
      } else {
        db.prepare("UPDATE ticket_conversation SET kind='context' WHERE ticket=? AND conversation=?").run(owner.id, row.conversation);
        owner = null;
      }
    }
    const context = db.prepare("SELECT ticket FROM ticket_conversation WHERE conversation=? AND kind='context' ORDER BY ticket").all(row.conversation).map((link) => Number(link.ticket));
    const matches = owner ? [] : refMatches(db, batchRefs(db, row));
    if (!owner && matches.length === 1) {
      owner = getTicket(db, matches[0]!);
      db.prepare(`INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,?,'linked','rule',?)
        ON CONFLICT(ticket,conversation) DO UPDATE SET kind='linked',"by"='rule'`).run(owner.id, row.conversation, now);
      history(db, owner.id, now, 'triage', 'rule', 'Conversation linked by shared reference', `route:${owner.id}:batch:${batch}`);
    }
    if (!owner) {
      db.prepare('UPDATE batch SET ticket=NULL WHERE id=?').run(batch);
      return { ticket: null, mode: 'new', candidates: matches, context };
    }
    adoptAnswered(db, row.conversation, owner.id, now);
    attachBatch(db, batch, owner.id, now);
    const mode = owner.lifecycle === 'proposed' ? 'update' : 'forward';
    if (row.state === 'pending') db.prepare('UPDATE batch SET outcome=? WHERE id=?').run(mode === 'update' ? 'triage' : 'routed', batch);
    return { ticket: owner.id, mode, candidates: [], context: context.filter((id) => id !== owner!.id) };
  });
}

export interface OwnContext {
  batch_ids: number[];
  messages: Message[];
}

// context_ids on an immutable turn contains answered batch ids, not mutable message row ids.
function consumedContext(db: DatabaseSync): Set<number> {
  return new Set(db.prepare("SELECT context_ids FROM turn WHERE state<>'cancelled'").all()
    .flatMap((turn) => JSON.parse(String(turn.context_ids)) as number[]));
}

function adoptAnswered(db: DatabaseSync, conversation: number, ticket: number, at: string): void {
  const consumed = consumedContext(db);
  for (const batch of db.prepare("SELECT id FROM batch WHERE conversation=? AND outcome='answered' AND ticket IS NULL ORDER BY id").all(conversation)) {
    if (!consumed.has(Number(batch.id))) attachBatch(db, Number(batch.id), ticket, at);
  }
}

export function ownContext(db: DatabaseSync, ticket: number): OwnContext {
  getTicket(db, ticket);
  const consumed = consumedContext(db);
  const batches = db.prepare("SELECT id FROM batch WHERE ticket=? AND outcome='answered' ORDER BY id").all(ticket)
    .map((batch) => Number(batch.id)).filter((id) => !consumed.has(id) && batchMessages(db, id).length > 0);
  return { batch_ids: batches, messages: batches.flatMap((batch) => batchMessages(db, batch)) };
}

export function assessmentPayload(db: DatabaseSync, cfg: Config, batch: number, routed: Route, at?: string) {
  const row = getBatch(db, batch);
  const offered = candidates(db, cfg, batch, at);
  const ids = [...new Set([...offered.map((candidate) => candidate.id), ...(routed.ticket === null ? [] : [routed.ticket])])];
  return { batch, mode: routed.mode, ticket: routed.ticket, conversation_title: row.title, candidates: offered, candidate_ids: ids,
    allowed_clients: Object.keys(cfg.clients), inferred_clients: batchClients(db, cfg, batch), context_ticket_ids: routed.context,
    min_confidence: cfg.triage.min_confidence, reopen_days: cfg.jobs.reopen_days,
    message_versions: batchMessages(db, batch).map((message) => ({ id: message.id, stored_at: message.stored_at, version: messageVersion(message) })) };
}

export const modelDecisionSchema = z.strictObject({
  on_us: z.boolean(), reason: z.string().min(1), action: z.enum(['new', 'update', 'skip']), ticket: z.number().int().positive().nullable(),
  title: z.string(), client: z.string().min(1).nullable(),
  summary: z.string().describe('Quick sum-up in at most two short sentences: who wants what, by when'),
  ask: z.string().describe('The request in one sentence'), proposal: z.string().describe('At most three short numbered steps'),
  kb_notes: z.array(z.string().refine(isNotePath, 'Unsafe relative Markdown note path')), confidence: z.number().finite().min(0).max(1),
}).refine((decision) => decision.action === 'skip' ? !decision.on_us && decision.ticket === null
  : decision.on_us && decision.title.trim().length > 0 && (decision.action === 'update' ? decision.ticket !== null : decision.ticket === null),
{ message: 'Contradictory decision action, on_us, ticket or title' });

export const decisionSchema = modelDecisionSchema.safeExtend({ raw: z.string().optional() });

export type Decision = z.infer<typeof decisionSchema>;

function proposedFields(db: DatabaseSync, ticket: number, decision: Decision, at: string): void {
  db.prepare('UPDATE ticket SET title=?,client=?,summary=?,ask=?,proposal=?,kb_notes=?,confidence=?,last_activity_at=? WHERE id=? AND lifecycle=\'proposed\'')
    .run(decision.title, decision.client, decision.summary, decision.ask, decision.proposal, JSON.stringify(decision.kb_notes), decision.confidence, at, ticket);
}

function newProposal(db: DatabaseSync, decision: Decision, at: string, maybe: number | null): number {
  return Number(db.prepare(`INSERT INTO ticket(title,client,summary,ask,proposal,kb_notes,confidence,created_at,last_activity_at,maybe_ticket)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(decision.title, decision.client, decision.summary, decision.ask, decision.proposal,
    JSON.stringify(decision.kb_notes), decision.confidence, at, at, maybe).lastInsertRowid);
}

function installLink(db: DatabaseSync, ticket: number, conversation: number, kind: 'primary' | 'linked' | 'context', by: 'agent' | 'you' | 'chat', at: string): void {
  db.prepare(`INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(ticket,conversation) DO UPDATE SET kind=excluded.kind,"by"=excluded."by"`).run(ticket, conversation, kind, by, at);
  if (kind !== 'context') adoptAnswered(db, conversation, ticket, at);
}

export function applyDecision(db: DatabaseSync, batch: number, input: unknown): number | null {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) throw new TicketError('ticket.invalid-decision', parsed.error.message);
  const decision = parsed.data;
  return transaction(db, () => {
    const now = utc();
    const row = getBatch(db, batch);
    const job = db.prepare("SELECT payload FROM job WHERE kind='triage' AND json_extract(payload,'$.batch')=? ORDER BY id DESC LIMIT 1").get(batch);
    if (!job) throw new TicketError('ticket.conflict', `Batch ${batch} has no offered assessment`);
    const scope = JSON.parse(String(job.payload)) as { conversation_title: string | null; candidate_ids: number[]; allowed_clients: string[]; min_confidence: number;
      reopen_days: number; message_versions: { id: number; stored_at: string; version: string }[] };
    if (!Array.isArray(scope.candidate_ids) || !Array.isArray(scope.allowed_clients) || !Array.isArray(scope.message_versions)) {
      throw new TicketError('ticket.conflict', 'Assessment has no candidate/client/input scope');
    }
    if (scope.conversation_title !== null && typeof scope.conversation_title !== 'string') {
      throw new TicketError('ticket.conflict', 'Assessment conversation title scope is missing or invalid');
    }
    if (scope.conversation_title !== row.title) throw new TicketError('ticket.conflict', 'Assessment conversation title changed');
    if (decision.ticket !== null && !scope.candidate_ids.includes(decision.ticket)) throw new TicketError('ticket.invalid-decision', 'Ticket is not an offered candidate');
    if (decision.client !== null && !scope.allowed_clients.includes(decision.client)) throw new TicketError('ticket.invalid-decision', 'Unknown configured client');
    const { raw: suppliedRaw, ...fields } = decision;
    const raw = suppliedRaw ?? JSON.stringify(fields);
    const previous = db.prepare("SELECT raw FROM triage_log WHERE batch=? AND action IN ('new','update','skip') ORDER BY id DESC LIMIT 1").get(batch);
    if (previous) {
      if (previous.raw !== raw) throw new TicketError('ticket.conflict', 'Batch already has a different assessment');
      return row.ticket;
    }
    const versions = batchMessages(db, batch).map((message) => ({ id: message.id, stored_at: message.stored_at, version: messageVersion(message) }));
    if (JSON.stringify(versions) !== JSON.stringify(scope.message_versions)) throw new TicketError('ticket.conflict', 'Assessment input version changed');
    const routed = route(db, batch, now, scope.reopen_days);
    let owner = routed.ticket;
    let outcome: string;
    if (routed.mode === 'closed') outcome = 'closed';
    else if (routed.mode === 'forward') outcome = 'routed';
    else if (!decision.on_us) {
      owner = null;
      outcome = 'not_on_us';
    } else {
      // A different request in a chat that feeds a proposed ticket gets its own ticket; the chat keeps routing to the first one
      const separate = routed.mode === 'update' && decision.action === 'new';
      if (separate) owner = null;
      let maybe: number | null = null;
      if (owner === null && decision.ticket !== null) {
        const candidate = getTicket(db, decision.ticket);
        if (decision.confidence >= scope.min_confidence && (candidate.lifecycle === 'proposed' || candidate.lifecycle === 'active')) owner = candidate.id;
        else if (decision.confidence >= scope.min_confidence && candidate.lifecycle === 'done' && !candidate.merged_into
          && candidate.closed_at && utc(candidate.closed_at) >= daysBefore(now, scope.reopen_days) && inputAt(db, row, candidate.id) > utc(candidate.closed_at)) {
          db.prepare('UPDATE ticket SET lifecycle=?,report=NULL,last_activity_at=? WHERE id=?').run(candidate.approved_at ? 'active' : 'proposed', now, candidate.id);
          owner = candidate.id;
        } else maybe = candidate.id;
      }
      if (owner === null) {
        owner = newProposal(db, decision, now, maybe);
        if (maybe !== null) installLink(db, maybe, row.conversation, 'context', 'agent', now);
        if (!separate) installLink(db, owner, row.conversation, 'primary', 'agent', now);
      } else {
        if (routed.ticket === null) installLink(db, owner, row.conversation, 'linked', 'agent', now);
        proposedFields(db, owner, decision, now);
      }
      attachBatch(db, batch, owner, now);
      outcome = getTicket(db, owner).lifecycle === 'proposed' ? 'proposed' : 'routed';
    }
    const done = outcome !== 'routed';
    db.prepare('UPDATE batch SET ticket=?,outcome=?,state=?,done_at=? WHERE id=?').run(owner, outcome, done ? 'done' : 'pending', done ? now : null, batch);
    db.prepare(`INSERT INTO triage_log(batch,conversation,at,relevant,assigned_to_me,action,work_item,reason,confidence,candidates,raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(batch, row.conversation, now, Number(decision.on_us), Number(decision.on_us), decision.action,
      owner === null ? null : String(owner), decision.reason, decision.confidence, JSON.stringify(scope.candidate_ids), raw);
    if (owner !== null) history(db, owner, now, 'triage', 'agent', decision.reason, `triage:batch:${batch}`);
    return owner;
  });
}

function validId(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TicketError('ticket.invalid-input', `Invalid ${name} id`);
}

function correctionJobs(db: DatabaseSync): Job[] {
  return db.prepare("SELECT * FROM job WHERE state IN ('queued','running','parked') OR reserved_at IS NOT NULL").all()
    .map((row) => ({ ...row, payload: JSON.parse(String(row.payload)) }) as unknown as Job);
}

const immutableJobFields = ['prompt_id', 'text', 'session_id', 'turn', 'turn_id', 'input_turn', 'recovery_of'];

function immutableJob(job: Job): boolean {
  return job.reserved_at !== null || job.turn_id !== null || job.kind === 'collect'
    || ['start_chat', 'forward'].includes(job.kind) && (job.state === 'running'
      || immutableJobFields.some((field) => job.payload[field] !== undefined && job.payload[field] !== null));
}

function rebindSafe(db: DatabaseSync, tickets: readonly number[]): void {
  for (const ticket of new Set(tickets)) {
    if (db.prepare("SELECT 1 FROM turn WHERE ticket=? AND state IN ('prepared','admitted','running')").get(ticket)) {
      throw new TicketError('ticket.conflict', `Ticket ${ticket} has prepared, admitted or running input; resolve it before rebinding`);
    }
    if (correctionJobs(db).some((job) => job.ticket === ticket && immutableJob(job))) {
      throw new TicketError('ticket.conflict', `Ticket ${ticket} has reserved, immutable or unresolved input work`);
    }
  }
}

function jobBatches(job: Job, tail = true): number[] {
  const ids: number[] = [];
  for (const field of ['batch_ids', ...(tail ? ['pending_batch_ids'] : [])]) {
    const value = job.payload[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new TicketError('ticket.conflict', `Job ${job.id} has invalid ${field}`);
    ids.push(...value as number[]);
  }
  if (job.payload.batch !== undefined) {
    if (!Number.isSafeInteger(job.payload.batch) || Number(job.payload.batch) <= 0) throw new TicketError('ticket.conflict', `Job ${job.id} has invalid batch`);
    ids.push(Number(job.payload.batch));
  }
  return [...new Set(ids)];
}

function cancelJob(db: DatabaseSync, id: number, at: string): void {
  db.prepare("UPDATE job SET state='cancelled',lease_until=NULL,lease_token=NULL,run_id=NULL,reserved_at=NULL,updated_at=? WHERE id=?")
    .run(at, id);
}

function cancelReboundFuture(db: DatabaseSync, source: number | null, at: string, conversation?: number): void {
  const triage = new Set(db.prepare(`SELECT j.id FROM job j JOIN batch b ON b.id=json_extract(j.payload,'$.batch')
    WHERE j.kind='triage' AND ${conversation === undefined ? 'b.ticket' : 'b.conversation'}=?`).all(conversation ?? source).map((job) => Number(job.id)));
  for (const job of correctionJobs(db).filter((job) => ['triage', 'start_chat', 'forward'].includes(job.kind)
    && (source !== null && job.ticket === source || triage.has(job.id)))) {
    const ids = jobBatches(job);
    const affected = conversation === undefined ? job.ticket === source || triage.has(job.id)
      : ids.some((id) => getBatch(db, id).conversation === conversation)
        || job.kind === 'start_chat' && job.ticket === source && !db.prepare("SELECT 1 FROM ticket_conversation WHERE ticket=? AND kind IN ('primary','linked')").get(source);
    if (!affected) continue;
    if (job.kind !== 'triage' && immutableJob(job)) throw new TicketError('ticket.conflict', `Job ${job.id} has immutable or unresolved input`);
    cancelJob(db, job.id, at);
    for (const id of ids) db.prepare("UPDATE batch SET outcome='pending',done_at=NULL WHERE id=? AND state='pending'").run(id);
  }
}

function correctionIntent(db: DatabaseSync, batch: number, target: number, at: string): void {
  const seq = Number(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS seq FROM timeline').get()!.seq);
  history(db, target, at, 'triage', 'rule', `Pending batch ${batch} transferred by correction`, `correction:batch:${batch}:ticket:${target}:${seq}`);
}

function moveFuture(db: DatabaseSync, source: number | null, target: number, at: string, conversation?: number): void {
  const own = source === null ? [] : ownContext(db, source).batch_ids;
  for (const row of db.prepare("SELECT id,conversation,ticket,state,outcome FROM batch WHERE state='pending' OR outcome='answered'").all()) {
    if (conversation === undefined ? row.ticket !== source : row.conversation !== conversation) continue;
    const id = Number(row.id);
    if (row.outcome === 'answered') {
      if (!own.includes(id)) continue;
    } else if (db.prepare("SELECT 1 FROM job WHERE kind='triage' AND json_extract(payload,'$.batch')=?").get(id)) {
      // Enqueue keys and old assessment payloads stay historical. Corrected input gets a fresh batch identity.
      const replacement = Number(db.prepare("INSERT INTO batch(conversation,state,created_at,outcome,ticket) VALUES (?,'pending',?,'pending',?)")
        .run(row.conversation!, at, target).lastInsertRowid);
      db.prepare('UPDATE message SET batch=? WHERE batch=?').run(replacement, id);
      db.prepare("UPDATE batch SET state='done',outcome='corrected',done_at=? WHERE id=?").run(at, id);
      attachBatch(db, replacement, target, at);
      correctionIntent(db, replacement, target, at);
      continue;
    } else db.prepare("UPDATE batch SET outcome='pending',done_at=NULL WHERE id=?").run(id);
    attachBatch(db, id, target, at);
    if (row.outcome !== 'answered') correctionIntent(db, id, target, at);
  }
}

export function relink(db: DatabaseSync, conversation: number, target: number, at?: string, actor: 'you' | 'chat' = 'you'): number {
  validId(conversation, 'conversation');
  return transaction(db, () => {
    const now = utc(at);
    if (!db.prepare('SELECT 1 FROM conversation WHERE id=?').get(conversation)) throw new TicketError('ticket.not-found', `Conversation ${conversation} not found`);
    const to = getTicket(db, target);
    const old = db.prepare("SELECT ticket FROM ticket_conversation WHERE conversation=? AND kind IN ('primary','linked')").get(conversation);
    const source = old ? Number(old.ticket) : null;
    if (source === target) return target;
    if (to.lifecycle === 'done' || to.lifecycle === 'dismissed') throw new TicketError('ticket.conflict', 'Cannot relink to a terminal ticket');
    rebindSafe(db, source === null ? [target] : [source, target]);
    if (source !== null) db.prepare("UPDATE ticket_conversation SET kind='context' WHERE ticket=? AND conversation=?").run(source, conversation);
    cancelReboundFuture(db, source, now, conversation);
    installLink(db, target, conversation, 'linked', actor, now);
    moveFuture(db, source, target, now, conversation);
    const seq = Number(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS seq FROM timeline').get()!.seq);
    const body = `Conversation ${conversation} relinked from ${source === null ? 'no ticket' : `#${source}`} to #${target}`;
    if (source !== null) history(db, source, now, 'triage', actor, body, `relink:${seq}:${conversation}:${source}:${target}:source`);
    history(db, target, now, 'triage', actor, body, `relink:${seq}:${conversation}:${source}:${target}:target`);
    return target;
  });
}

export function merge(db: DatabaseSync, source: number, target: number, at?: string, actor: 'you' | 'chat' = 'you'): number {
  return transaction(db, () => {
    const now = utc(at);
    const from = getTicket(db, source);
    const to = getTicket(db, target);
    if (source === target) throw new TicketError('ticket.invalid-input', 'Cannot merge a ticket into itself');
    if (from.merged_into === target) return target;
    if (from.merged_into !== null) throw new TicketError('ticket.conflict', `Ticket ${source} is already merged into #${from.merged_into}`);
    if (to.lifecycle === 'done' || to.lifecycle === 'dismissed') throw new TicketError('ticket.conflict', 'Cannot merge into a terminal ticket');
    rebindSafe(db, [source, target]);
    const links = db.prepare('SELECT conversation,kind FROM ticket_conversation WHERE ticket=? ORDER BY conversation').all(source);
    db.prepare("UPDATE ticket_conversation SET kind='context' WHERE ticket=? AND kind IN ('primary','linked')").run(source);
    cancelReboundFuture(db, source, now);
    for (const link of links) {
      const existing = db.prepare('SELECT kind FROM ticket_conversation WHERE ticket=? AND conversation=?').get(target, link.conversation!);
      if (existing && existing.kind !== 'context') continue;
      const primary = db.prepare("SELECT 1 FROM ticket_conversation WHERE ticket=? AND kind='primary'").get(target);
      const kind = link.kind === 'context' ? 'context' : link.kind === 'primary' && !primary ? 'primary' : 'linked';
      installLink(db, target, Number(link.conversation), kind, actor, now);
    }
    moveFuture(db, source, target, now);
    const refs = db.prepare('SELECT kind,key,url,seen_in FROM ticket_ref WHERE ticket=? ORDER BY id').all(source) as unknown as TicketRef[];
    addRefs(db, target, refs, now);
    const reportAt = from.report_at && utc(from.report_at) > now ? from.report_at : now;
    db.prepare("UPDATE ticket SET lifecycle='done',merged_into=?,closed_at=?,report='done',report_line=?,report_at=?,last_activity_at=? WHERE id=?")
      .run(target, now, `Merged into #${target}`, reportAt, now, source);
    history(db, source, now, 'merge', actor, `Merged into #${target}`, `merge:${source}:${target}:source`);
    history(db, target, now, 'merge', actor, `Merged #${source} into this ticket`, `merge:${source}:${target}:target`);
    return target;
  });
}

function closeFuture(db: DatabaseSync, ticket: number, at: string): void {
  const jobs = correctionJobs(db);
  const triage = new Set(db.prepare(`SELECT j.id FROM job j JOIN batch b ON b.id=json_extract(j.payload,'$.batch')
    WHERE j.kind='triage' AND b.ticket=?`).all(ticket).map((job) => Number(job.id)));
  const safe = new Set<number>();
  for (const turn of db.prepare("SELECT id FROM turn WHERE ticket=? AND state='prepared' AND reserved_at IS NULL AND admitted_at IS NULL AND last_error IS NULL").all(ticket)) {
    const id = Number(turn.id);
    if (jobs.some((job) => job.turn_id === id && (job.reserved_at !== null || job.state === 'running'))) continue;
    db.prepare("UPDATE turn SET state='cancelled',completed_at=? WHERE id=?").run(at, id);
    safe.add(id);
  }
  const protectedBatches = new Set(db.prepare("SELECT batch FROM turn WHERE ticket=? AND state IN ('prepared','admitted','running') AND batch IS NOT NULL").all(ticket)
    .map((turn) => Number(turn.batch)));
  for (const job of jobs) {
    if (job.ticket !== ticket && !triage.has(job.id)) continue;
    if (!['triage', 'start_chat', 'forward', 'collect'].includes(job.kind)) continue;
    const retained = job.kind !== 'triage' && immutableJob(job) && !(job.turn_id !== null && safe.has(job.turn_id));
    if (retained) for (const id of jobBatches(job, false)) protectedBatches.add(id);
    else cancelJob(db, job.id, at);
  }
  for (const batch of db.prepare("SELECT id FROM batch WHERE ticket=? AND state='pending'").all(ticket)) {
    if (!protectedBatches.has(Number(batch.id))) db.prepare("UPDATE batch SET state='done',outcome='closed',done_at=? WHERE id=?").run(at, batch.id!);
  }
}

function finishTicket(db: DatabaseSync, ticket: number, lifecycle: 'done' | 'dismissed', reason: string, at?: string, actor: 'you' | 'chat' = 'you'): number {
  if (typeof reason !== 'string') throw new TicketError('ticket.invalid-input', 'Correction reason must be a string');
  return transaction(db, () => {
    const now = utc(at);
    const row = getTicket(db, ticket);
    if (row.lifecycle === lifecycle) return ticket;
    if (row.lifecycle === 'done' || row.lifecycle === 'dismissed') throw new TicketError('ticket.conflict', 'Ticket already has a terminal lifecycle');
    closeFuture(db, ticket, now);
    const reportAt = row.report_at && utc(row.report_at) > now ? row.report_at : now;
    db.prepare("UPDATE ticket SET lifecycle=?,closed_at=?,report='done',report_line=?,report_at=?,last_activity_at=? WHERE id=?")
      .run(lifecycle, now, reason || (lifecycle === 'done' ? 'Closed manually' : 'Dismissed'), reportAt, now, ticket);
    const base = `${lifecycle === 'done' ? 'close' : 'dismiss'}:ticket:${ticket}`;
    const existing = db.prepare('SELECT 1 FROM timeline WHERE event_key=?').get(base);
    const seq = Number(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS seq FROM timeline').get()!.seq);
    history(db, ticket, now, 'status', actor, reason, existing ? `${base}:${seq}` : base);
    return ticket;
  });
}

export function close(db: DatabaseSync, ticket: number, reason = '', at?: string, actor: 'you' | 'chat' = 'you'): number {
  return finishTicket(db, ticket, 'done', reason, at, actor);
}

export function dismiss(db: DatabaseSync, ticket: number, reason = '', at?: string, actor: 'you' | 'chat' = 'you'): number {
  return finishTicket(db, ticket, 'dismissed', reason, at, actor);
}

export const MUTE_FOREVER = '9999-12-31T23:59:59.000000Z';

// Later batches of a muted conversation skip triage and forwarding until muted_until. hours null: until unmuted; 0: unmute.
export function mute(db: DatabaseSync, conversation: number, hours: number | null, at?: string): number {
  return transaction(db, () => {
    validId(conversation, 'conversation');
    if (hours !== null && (!Number.isSafeInteger(hours) || hours < 0 || hours > 8_760)) throw new TicketError('ticket.invalid-input', 'Mute hours must be 0..8760 or null');
    const until = hours === null ? MUTE_FOREVER : hours === 0 ? null : utc(new Date(Date.parse(utc(at)) + hours * 3_600_000).toISOString());
    if (db.prepare('UPDATE conversation SET muted_until=? WHERE id=?').run(until, conversation).changes === 0) {
      throw new TicketError('ticket.not-found', `Conversation ${conversation} not found`);
    }
    return conversation;
  });
}

export function muteBatch(db: DatabaseSync, batch: number, hours: number | null, at?: string): number {
  return transaction(db, () => mute(db, getBatch(db, batch).conversation, hours, at));
}

export function muteTicket(db: DatabaseSync, ticket: number, hours: number | null, at?: string): number[] {
  return transaction(db, () => {
    getTicket(db, ticket);
    return db.prepare("SELECT conversation FROM ticket_conversation WHERE ticket=? AND kind IN ('primary','linked') ORDER BY conversation").all(ticket)
      .map((row) => mute(db, Number(row.conversation), hours, at));
  });
}

// Takes a skipped batch off the page; its messages and outcome stay for triage feedback.
export function clearBatch(db: DatabaseSync, batch: number, at?: string): number {
  return transaction(db, () => {
    const row = getBatch(db, batch);
    if (!['not_on_us', 'backlog', 'answered', 'muted'].includes(row.outcome ?? '')) throw new TicketError('ticket.conflict', 'Clear requires a skipped, backlog, answered or muted batch');
    db.prepare('UPDATE batch SET cleared_at=COALESCE(cleared_at,?) WHERE id=?').run(utc(at), batch);
    return batch;
  });
}

// Takes a dismissed or done ticket off the page; the ticket and its history stay.
export function clearTicket(db: DatabaseSync, ticket: number, at?: string): number {
  return transaction(db, () => {
    const row = getTicket(db, ticket);
    if (row.lifecycle !== 'dismissed' && row.lifecycle !== 'done') throw new TicketError('ticket.conflict', 'Clear requires a dismissed or done ticket');
    db.prepare('UPDATE ticket SET cleared_at=COALESCE(cleared_at,?) WHERE id=?').run(utc(at), ticket);
    return ticket;
  });
}

export function makeTicket(db: DatabaseSync, batch: number, at?: string, actor: 'you' | 'chat' = 'you'): number {
  return transaction(db, () => {
    const now = utc(at);
    const row = getBatch(db, batch);
    const key = `make-ticket:batch:${batch}`;
    const made = db.prepare('SELECT ticket FROM timeline WHERE event_key=?').get(key);
    if (made) return Number(made.ticket);
    if (!['not_on_us', 'backlog', 'answered', 'muted'].includes(row.outcome ?? '')) throw new TicketError('ticket.conflict', 'Make ticket requires a skipped, backlog, answered or muted batch');
    if (row.outcome === 'muted') mute(db, row.conversation, 0, now);
    const linked = db.prepare("SELECT ticket FROM ticket_conversation WHERE conversation=? AND kind IN ('primary','linked')").get(row.conversation);
    let owner = linked ? getTicket(db, Number(linked.ticket)) : null;
    if (owner && (owner.lifecycle === 'done' || owner.lifecycle === 'dismissed')) {
      rebindSafe(db, [owner.id]);
      db.prepare("UPDATE ticket_conversation SET kind='context' WHERE ticket=? AND conversation=?").run(owner.id, row.conversation);
      owner = null;
    }
    if (owner === null) {
      const summary = batchMessages(db, batch).map((message) => JSON.parse(message.ref ?? '{}').deleted === true ? '[Source message deleted]' : message.text ?? '').join('\n');
      const id = Number(db.prepare('INSERT INTO ticket(title,summary,created_at,last_activity_at) VALUES (?,?,?,?)').run(row.title || '(no title)', summary, now, now).lastInsertRowid);
      installLink(db, id, row.conversation, 'primary', actor, now);
      owner = getTicket(db, id);
    }
    attachBatch(db, batch, owner.id, now);
    const outcome = row.outcome === 'answered' && linked && Number(linked.ticket) === owner.id ? 'answered'
      : owner.lifecycle === 'active' ? 'routed' : 'proposed';
    db.prepare('UPDATE batch SET state=?,outcome=?,done_at=? WHERE id=?').run(outcome === 'routed' ? 'pending' : 'done', outcome, outcome === 'routed' ? null : now, batch);
    history(db, owner.id, now, 'triage', actor, `Made ticket from ${row.outcome}`, key);
    return owner.id;
  });
}

export function feedback(db: DatabaseSync) {
  const reasons = db.prepare("SELECT ticket,body AS reason,at FROM timeline WHERE event_key LIKE 'dismiss:ticket:%' ORDER BY id").all()
    .map((row) => ({ ticket: Number(row.ticket), reason: String(row.reason), at: String(row.at) }));
  return { make_ticket_count: Number(db.prepare("SELECT COUNT(*) AS n FROM timeline WHERE event_key LIKE 'make-ticket:batch:%'").get()!.n),
    dismiss_count: reasons.length, dismiss_reasons: reasons };
}

export interface TicketRef {
  kind: 'jira' | 'snow' | 'github_pr' | 'gitlab_mr' | 'ado_pr';
  key: string;
  url: string | null;
  seen_in: 'message' | 'chat';
}

const excludedProjects = new Set(['UTF', 'ISO', 'SHA', 'RFC', 'TLS', 'SSL', 'AES', 'RSA', 'HTTP', 'WIN', 'COVID', 'CVE', 'GPT', 'PCI', 'MD']);

function cleanUrl(text: string): string {
  let value = text.replace(/[.,;:!?]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    while (value.endsWith(close!) && value.split(close!).length > value.split(open!).length) value = value.slice(0, -1);
  }
  return value.replace(/[.,;:!?]+$/, '');
}

function pullRef(url: URL): Pick<TicketRef, 'kind' | 'key'> | null {
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  let parts: string[];
  try {
    parts = url.pathname.replace(/\/+$/, '').split('/').slice(1).map((part) => decodeURIComponent(part).toLowerCase());
  } catch {
    return null;
  }
  if (parts.some((part) => !part || /[/\\]/.test(part))) return null;
  const numeric = parts.at(-1)!;
  if (!/^\d+$/.test(numeric) || BigInt(numeric) <= 0n) return null;
  const number = String(BigInt(numeric));
  const path = (values: string[]) => values.map((part) => encodeURIComponent(part).toLowerCase()).join('/');
  if (host === 'github.com' && parts.length === 4 && parts[2] === 'pull') {
    return { kind: 'github_pr', key: `https://github.com/${path(parts.slice(0, 2))}/pull/${number}` };
  }
  if (parts.length >= 5 && parts.at(-3) === '-' && parts.at(-2) === 'merge_requests') {
    return { kind: 'gitlab_mr', key: `https://${host}/${path(parts.slice(0, -3))}/-/merge_requests/${number}` };
  }
  let org: string | undefined;
  if (host === 'dev.azure.com') org = parts.shift();
  else if (/^[a-z0-9-]+\.visualstudio\.com$/.test(host)) {
    org = host.split('.')[0];
    if (parts[0] === 'defaultcollection') parts.shift();
  }
  if (org && parts.length === 5 && parts[1] === '_git' && parts[3] === 'pullrequest') {
    return { kind: 'ado_pr', key: `https://dev.azure.com/${path([org, parts[0]!, '_git', parts[2]!, 'pullrequest'])}/${number}` };
  }
  return null;
}

export function extractRefs(text: string, seenIn: TicketRef['seen_in']): TicketRef[] {
  if (typeof text !== 'string') throw new TypeError('Reference text must be a string');
  if (seenIn !== 'message' && seenIn !== 'chat') throw new TypeError('Invalid reference seen_in');
  const urls: { start: number; end: number; url: URL }[] = [];
  const found: { at: number; ref: TicketRef }[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    try {
      const url = new URL(cleanUrl(match[0]));
      urls.push({ start: match.index, end: match.index + match[0].length, url });
      const ref = pullRef(url);
      if (ref) found.push({ at: match.index, ref: { ...ref, url: url.href, seen_in: seenIn } });
    } catch {
      // Malformed URLs are not pull request identities.
    }
  }
  for (const [kind, pattern] of [
    ['jira', /\b([a-z][a-z0-9]{1,9})-[1-9]\d{0,6}\b/gi],
    ['snow', /\b(?:INC|CHG|RITM|TASK)\d+\b/gi],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      if (kind === 'jira' && excludedProjects.has(match[1]!.toUpperCase())) continue;
      const url = urls.find((entry) => match.index >= entry.start && match.index < entry.end)?.url.href ?? null;
      found.push({ at: match.index, ref: { kind, key: match[0].toUpperCase(), url, seen_in: seenIn } });
    }
  }
  const unique = new Map<string, TicketRef>();
  for (const { ref } of found.sort((a, b) => a.at - b.at)) {
    const identity = `${ref.kind}:${ref.key}`;
    const previous = unique.get(identity);
    if (!previous) unique.set(identity, ref);
    else if (!previous.url && ref.url) previous.url = ref.url;
  }
  return [...unique.values()];
}

export function addRefs(db: DatabaseSync, ticket: number, refs: readonly TicketRef[], at?: string): number {
  return transaction(db, () => {
    const now = utc(at);
    getTicket(db, ticket);
    let added = 0;
    for (const ref of refs) {
      const inserted = db.prepare('INSERT INTO ticket_ref(ticket,kind,key,url,seen_in) VALUES (?,?,?,?,?) ON CONFLICT(ticket,kind,key) DO NOTHING')
        .run(ticket, ref.kind, ref.key, ref.url, ref.seen_in).changes;
      const key = `ref:${ticket}:${ref.kind}:${ref.key}`;
      if (!inserted) {
        if (ref.url !== null) {
          db.prepare('UPDATE ticket_ref SET url=? WHERE ticket=? AND kind=? AND key=? AND url IS NULL').run(ref.url, ticket, ref.kind, ref.key);
          db.prepare('UPDATE timeline SET link=? WHERE event_key=? AND link IS NULL').run(ref.url, key);
        }
        continue;
      }
      history(db, ticket, now, 'ref', ref.seen_in, ref.key, key, ref.url);
      added++;
    }
    return added;
  });
}
