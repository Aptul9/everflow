import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { clientsFor, isNotePath } from './policy.ts';
import type { Config } from './config.ts';
import { transaction } from './db.ts';
import type { Job } from './jobs.ts';
import { calendarDay, utc } from './time.ts';
import type { Lifecycle, Report } from './types.ts';

export type Stage = 'Failed' | 'Needs you' | 'Working' | 'Waiting on them' | 'Idle' | 'Done' | 'Dismissed';
export type Column = 'Needs you' | 'Working' | 'Waiting on them' | 'Failed' | 'Done' | 'Skipped';

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
  // 'ai' when the AI suggested the ticket
  origin?: string | null;
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
  prompt_id: string | null;
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

// What triage needs to judge new input against a closed ticket: the request, how it was closed, the last chat report and the
// newest `limit` timeline entries (messages, chat reports, status changes), oldest first.
export function ticketRecord(db: DatabaseSync, ticket: number, limit = 60) {
  const row = getTicket(db, ticket);
  const timeline = (db.prepare("SELECT at,kind,actor,body FROM timeline WHERE ticket=? AND kind IN ('message','status','chat','comment','approval') ORDER BY at DESC,id DESC LIMIT ?")
    .all(ticket, limit) as unknown as Pick<TimelineEvent, 'at' | 'kind' | 'actor' | 'body'>[]).reverse()
    .map((event) => ({ at: event.at, kind: event.kind, actor: event.actor, body: event.body.slice(0, 1_000) }));
  const closing = db.prepare("SELECT actor,body FROM timeline WHERE ticket=? AND kind='status' AND at>=? ORDER BY at,id LIMIT 1").get(ticket, row.closed_at ?? row.created_at);
  return { id: row.id, title: row.title, client: row.client, lifecycle: row.lifecycle, summary: row.summary, ask: row.ask, proposal: row.proposal,
    approved: row.approved_at !== null, closed_at: row.closed_at, closed_by: closing ? String(closing.actor) : null, closing_note: closing ? String(closing.body) : null,
    last_report: row.report_line, timeline };
}

function batchRefs(db: DatabaseSync, batch: Batch): TicketRef[] {
  return extractRefs([batch.title ?? '', ...batchMessages(db, batch.id).map((message) => message.text ?? '')].join('\n'), 'message');
}

function inputAt(db: DatabaseSync, batch: Batch, target: number): string {
  const stamps = batchMessages(db, batch.id).map((message) => utc(message.stored_at));
  // A make-ticket, a correction or a triage reopen for this batch counts as its input time, so the close it predates does not drop it
  const intents = db.prepare('SELECT at FROM timeline WHERE ticket=? AND (event_key=? OR event_key=? OR event_key GLOB ?)')
    .all(target, `make-ticket:batch:${batch.id}`, `reopen:${target}:batch:${batch.id}`, `correction:batch:${batch.id}:ticket:${target}:*`);
  stamps.push(...intents.map((intent) => utc(String(intent.at))));
  return stamps.sort().at(-1) ?? utc(batch.created_at);
}

// Input of the closing day that no chat input ever carried was not handled by the close: it reopens the ticket chat.
// Earlier days, dismissed tickets and tickets without a chat keep the close as final.
function unseenAtClose(db: DatabaseSync, batch: Batch, owner: Ticket, closedAt: string): boolean {
  if (!owner.approved_at || !owner.session_id || owner.merged_into || batch.prompt_id) return false;
  const at = inputAt(db, batch, owner.id);
  if (calendarDay(at) !== calendarDay(closedAt)) return false;
  return !db.prepare("SELECT 1 FROM turn WHERE ticket=? AND state<>'cancelled' AND created_at>=?").get(owner.id, at);
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

// The board column a ticket's card sits in; the session title carries the same word
export function boardColumn(stage: Stage, lifecycle: Lifecycle): Column {
  if (lifecycle === 'dismissed' || stage === 'Dismissed') return 'Skipped';
  if (lifecycle === 'done' || stage === 'Done') return 'Done';
  return stage === 'Idle' ? 'Working' : stage;
}

// The session title is derived from the ticket alone, never written by the chat
export function stageTitle(db: DatabaseSync, ticket: number): string {
  const row = getTicket(db, ticket);
  return `[${boardColumn(stage(db, ticket), row.lifecycle)}] #${ticket} ${row.title}`;
}

// Messages a card shows and a chat brief quotes, newest first kept
export const TICKET_MESSAGES = 50;

// The ticket's own source: its primary and linked conversations and the batches attached to it, oldest first.
// A chat it only keeps as context (it was closed, merged or relinked) feeds later tickets, not this one.
export function ticketMessages(db: DatabaseSync, ticket: number): Message[] {
  return (db.prepare(`SELECT DISTINCT m.* FROM message m LEFT JOIN ticket_conversation l ON l.conversation=m.conversation
    LEFT JOIN batch b ON b.id=m.batch WHERE (l.ticket=? AND l.kind IN ('primary','linked')) OR b.ticket=?`).all(ticket, ticket) as unknown as Message[])
    .sort((a, b) => utc(a.sent_at).localeCompare(utc(b.sent_at)) || a.id - b.id);
}

export function detail(db: DatabaseSync, ticket: number) {
  const owner = getTicket(db, ticket);
  const timeline = (db.prepare('SELECT * FROM timeline WHERE ticket=?').all(ticket) as unknown as TimelineEvent[])
    .sort((a, b) => utc(b.at).localeCompare(utc(a.at)) || b.id - a.id);
  const messages = ticketMessages(db, ticket).slice(-TICKET_MESSAGES).reverse();
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

// Keys `source:account`, account lower-case
export function pausedInputs(db: DatabaseSync): Set<string> {
  return new Set(db.prepare('SELECT source,account FROM input_pause').all().map((row) => `${row.source}:${row.account}`));
}

export function batchPaused(db: DatabaseSync, batch: number, paused = pausedInputs(db)): boolean {
  if (!paused.size) return false;
  const row = getBatch(db, batch);
  return paused.has(`${row.source}:${row.account.toLowerCase()}`);
}

export function pauseInput(db: DatabaseSync, source: string, account: string, paused: boolean, at?: string): string {
  const key = account.trim().toLowerCase();
  const known = db.prepare(`SELECT 1 FROM conversation WHERE source=? AND lower(account)=? UNION SELECT 1 FROM cursor WHERE source=? AND lower(account)=?`)
    .get(source, key, source, key);
  if (!known) throw new TicketError('ticket.invalid-input', `Unknown account ${account} of source ${source}`);
  transaction(db, () => {
    if (paused) db.prepare('INSERT INTO input_pause(source,account,paused_at) VALUES (?,?,?) ON CONFLICT(source,account) DO NOTHING').run(source, key, utc(at));
    else db.prepare('DELETE FROM input_pause WHERE source=? AND account=?').run(source, key);
  });
  return `${source}:${key}`;
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

// One person across sources: the same person row, or the same name of two words or more in any order, as the relay's
// Teams display name ("irene laudanna") carries no address while the mail of the same person reads "Laudanna Irene"
function personKeys(message: Pick<Message, 'person' | 'sender' | 'sender_name'>): string[] {
  const keys = message.person === null ? [] : [`person:${message.person}`];
  const name = message.sender_name || (message.sender?.includes('@') ? '' : message.sender ?? '');
  const words = name.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\([^)]*\)/g, ' ').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean).sort();
  if (words.length >= 2) keys.push(`name:${words.join(' ')}`);
  return keys;
}

// Tickets one triage call may see, so the prompt stays bounded whatever the volume
export const MAX_CANDIDATES = 30;

export function candidates(db: DatabaseSync, cfg: Config, batch: number, at?: string): Candidate[] {
  const row = getBatch(db, batch);
  const clients = batchClients(db, cfg, batch);
  const references = new Set(refMatches(db, batchRefs(db, row)));
  const people = new Set(batchMessages(db, batch).filter((message) => !message.sender_is_me).flatMap(personKeys));
  const shared = new Set<number>();
  if (people.size) {
    for (const match of db.prepare(`SELECT DISTINCT l.ticket,m.person,m.sender,m.sender_name FROM message m
      JOIN ticket_conversation l ON l.conversation=m.conversation WHERE m.sender_is_me=0`).all()) {
      if (personKeys(match as unknown as Message).some((key) => people.has(key))) shared.add(Number(match.ticket));
    }
  }
  const cutoff = daysBefore(utc(at), cfg.jobs.reopen_days);
  // Customers never share tickets: a batch of a known client only sees that client's tickets
  return (db.prepare('SELECT * FROM ticket ORDER BY id').all() as unknown as Ticket[]).flatMap((ticket) => {
    if (clients.length && (ticket.client === null || !clients.includes(ticket.client))) return [];
    const open = ticket.lifecycle === 'proposed' || ticket.lifecycle === 'active';
    const sameClient = open && (ticket.client === null ? clients.length === 0 : clients.includes(ticket.client));
    const recent = [ticket.created_at, ticket.last_activity_at, ticket.closed_at].some((stamp) => stamp !== null && utc(stamp) >= cutoff);
    if (!sameClient && !recent && !shared.has(ticket.id) && !references.has(ticket.id)) return [];
    return [{ id: ticket.id, title: ticket.title, client: ticket.client, lifecycle: ticket.lifecycle, summary: ticket.summary,
      shared_people: shared.has(ticket.id), shared_ref: references.has(ticket.id), same_client: sameClient, recent,
      activity: utc(ticket.last_activity_at ?? ticket.created_at) }];
  }).sort((a, b) => Number(b.shared_ref) - Number(a.shared_ref) || Number(b.shared_people) - Number(a.shared_people)
    || Number(b.same_client) - Number(a.same_client) || b.activity.localeCompare(a.activity) || a.id - b.id)
    .slice(0, MAX_CANDIDATES).map(({ activity: _activity, ...candidate }) => candidate);
}

export interface Route {
  ticket: number | null;
  mode: 'new' | 'update' | 'follow' | 'forward' | 'closed' | 'reopen';
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

export function route(db: DatabaseSync, batch: number, at?: string, reopenDays = 2): Route {
  return transaction(db, () => {
    const now = utc(at);
    const row = getBatch(db, batch);
    const linked = db.prepare("SELECT ticket FROM ticket_conversation WHERE conversation=? AND kind IN ('primary','linked')").get(row.conversation);
    let owner = linked ? getTicket(db, Number(linked.ticket)) : null;
    if (owner?.closed_at && inputAt(db, row, owner.id) <= utc(owner.closed_at) && !owner.merged_into
      && !(owner.lifecycle === 'done' && unseenAtClose(db, row, owner, owner.closed_at))) {
      db.prepare("UPDATE batch SET ticket=?,state='done',outcome='closed',done_at=? WHERE id=?").run(owner.id, now, batch);
      const context = db.prepare("SELECT ticket FROM ticket_conversation WHERE conversation=? AND kind='context' ORDER BY ticket").all(row.conversation).map((link) => Number(link.ticket));
      return { ticket: owner.id, mode: 'closed', candidates: [], context };
    }
    if (owner && (owner.lifecycle === 'done' || owner.lifecycle === 'dismissed')) {
      if (owner.lifecycle === 'done' && !owner.merged_into && owner.closed_at && utc(owner.closed_at) >= daysBefore(now, reopenDays)) {
        // New input in the chat of a recently closed ticket: triage reads the ticket's record and decides whether it reopens,
        // starts a new ticket or is skipped. Thanks, call notices and chatter no longer reopen it by rule.
        db.prepare('UPDATE batch SET ticket=NULL WHERE id=?').run(batch);
        const context = db.prepare("SELECT ticket FROM ticket_conversation WHERE conversation=? AND kind='context' ORDER BY ticket").all(row.conversation).map((link) => Number(link.ticket));
        return { ticket: owner.id, mode: 'reopen', candidates: [owner.id], context };
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
    // New input for a running ticket chat is judged first; a batch triage, a correction or Antonio already let through is forwarded
    const mode = owner.lifecycle === 'proposed' ? 'update' : row.state === 'pending' && !['routed', 'forward'].includes(String(row.outcome)) ? 'follow' : 'forward';
    if (row.state === 'pending') db.prepare('UPDATE batch SET outcome=? WHERE id=?').run(mode === 'forward' ? 'routed' : 'triage', batch);
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
  // A follow-up is judged against its running ticket alone
  const offered = routed.mode === 'follow' ? [] : candidates(db, cfg, batch, at);
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
    const reopening = routed.mode === 'reopen';
    if (routed.mode === 'closed') outcome = 'closed';
    else if (routed.mode === 'forward') outcome = 'routed';
    // A follow-up goes to the running chat unless triage is sure the chat needs nothing from it
    else if (routed.mode === 'follow' && (decision.action === 'update' || !decision.on_us && decision.confidence < scope.min_confidence)) outcome = 'routed';
    // Skipped, it stays on the ticket's timeline without a turn; Make ticket still forwards it
    else if (routed.mode === 'follow' && !decision.on_us) outcome = 'not_on_us';
    else if (!decision.on_us) {
      // Skipped input leaves a closed ticket closed; its chat keeps feeding it, so later input is judged again
      owner = null;
      outcome = 'not_on_us';
    } else if (reopening && decision.action === 'update' && decision.ticket === routed.ticket && decision.confidence >= scope.min_confidence) {
      const closed = getTicket(db, routed.ticket!);
      db.prepare('UPDATE ticket SET lifecycle=?,report=NULL,last_activity_at=? WHERE id=?').run(closed.approved_at ? 'active' : 'proposed', now, closed.id);
      history(db, closed.id, now, 'status', 'agent', 'Reopened by triage', `reopen:${closed.id}:batch:${batch}`);
      if (!closed.approved_at) proposedFields(db, closed.id, decision, now);
      attachBatch(db, batch, closed.id, now);
      outcome = closed.approved_at ? 'routed' : 'proposed';
    } else {
      // Anything else than reopening the closed ticket takes the chat off it, as an expired close does
      if (reopening) {
        db.prepare("UPDATE ticket_conversation SET kind='context' WHERE ticket=? AND conversation=?").run(routed.ticket!, row.conversation);
        owner = null;
      }
      // A different request in a chat that feeds a proposed or running ticket gets its own ticket; the chat keeps routing to the first one
      const separate = (routed.mode === 'update' || routed.mode === 'follow') && decision.action === 'new';
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
        if (routed.ticket === null || reopening) installLink(db, owner, row.conversation, 'linked', 'agent', now);
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

// A follow-up triage could not judge still reaches the running chat, as it did before triage judged follow-ups
export function forwardUnjudged(db: DatabaseSync, batch: number, reason: string, at?: string): boolean {
  return transaction(db, () => {
    const now = utc(at);
    if (getBatch(db, batch).state !== 'pending') return false;
    const routed = route(db, batch, now);
    if (routed.mode !== 'follow') return false;
    db.prepare("UPDATE batch SET outcome='routed' WHERE id=?").run(batch);
    history(db, routed.ticket!, now, 'triage', 'rule', `Forwarded without a triage decision: ${reason}`, `triage:batch:${batch}`);
    return true;
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
  // Input a correction moves to a running ticket is Antonio's choice: it goes to the chat without a follow-up triage
  const moved = getTicket(db, target).lifecycle === 'active' ? 'routed' : 'pending';
  for (const row of db.prepare("SELECT id,conversation,ticket,state,outcome FROM batch WHERE state='pending' OR outcome='answered'").all()) {
    if (conversation === undefined ? row.ticket !== source : row.conversation !== conversation) continue;
    const id = Number(row.id);
    if (row.outcome === 'answered') {
      if (!own.includes(id)) continue;
    } else if (db.prepare("SELECT 1 FROM job WHERE kind='triage' AND json_extract(payload,'$.batch')=?").get(id)) {
      // Enqueue keys and old assessment payloads stay historical. Corrected input gets a fresh batch identity.
      const replacement = Number(db.prepare("INSERT INTO batch(conversation,state,created_at,outcome,ticket) VALUES (?,'pending',?,?,?)")
        .run(row.conversation!, at, moved, target).lastInsertRowid);
      db.prepare('UPDATE message SET batch=? WHERE batch=?').run(replacement, id);
      db.prepare("UPDATE batch SET state='done',outcome='corrected',done_at=? WHERE id=?").run(at, id);
      attachBatch(db, replacement, target, at);
      correctionIntent(db, replacement, target, at);
      continue;
    } else db.prepare('UPDATE batch SET outcome=?,done_at=NULL WHERE id=?').run(moved, id);
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

// A collector parked after its turn ended (recovery budget spent, unreadable report) has nothing left to collect; kept, it holds the ticket's later input
function deadCollector(db: DatabaseSync, job: Job): boolean {
  if (job.kind !== 'collect' || job.state !== 'parked') return false;
  const turn = db.prepare('SELECT state FROM turn WHERE id=?').get(Number(job.payload.turn));
  return turn?.state === 'done' || turn?.state === 'cancelled';
}

function closeFuture(db: DatabaseSync, ticket: number, at: string, keepUnseen = false): void {
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
    const retained = job.kind !== 'triage' && immutableJob(job) && !(job.turn_id !== null && safe.has(job.turn_id)) && !deadCollector(db, job);
    if (retained) for (const id of jobBatches(job, false)) protectedBatches.add(id);
    else cancelJob(db, job.id, at);
  }
  const owner = getTicket(db, ticket);
  for (const batch of db.prepare("SELECT id FROM batch WHERE ticket=? AND state='pending'").all(ticket)) {
    const id = Number(batch.id);
    if (protectedBatches.has(id)) continue;
    // Its cancelled forward is replaced on the next schedule, which reopens the ticket for it
    if (keepUnseen && unseenAtClose(db, getBatch(db, id), owner, at)) db.prepare("UPDATE batch SET outcome='routed' WHERE id=?").run(id);
    else db.prepare("UPDATE batch SET state='done',outcome='closed',done_at=? WHERE id=?").run(at, id);
  }
}

function finishTicket(db: DatabaseSync, ticket: number, lifecycle: 'done' | 'dismissed', reason: string, at?: string, actor: 'you' | 'chat' | 'agent' = 'you'): number {
  if (typeof reason !== 'string') throw new TicketError('ticket.invalid-input', 'Correction reason must be a string');
  return transaction(db, () => {
    const now = utc(at);
    const row = getTicket(db, ticket);
    // Already closed either way (Antonio may have dismissed it while its chat was closing it): left as it is
    if (row.lifecycle === 'done' || row.lifecycle === 'dismissed') return ticket;
    closeFuture(db, ticket, now, lifecycle === 'done');
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

export const MUTE_MAX_MINUTES = 525_600;

// Later batches of a muted conversation skip triage and forwarding until muted_until. minutes null: until unmuted; 0: unmute.
export function mute(db: DatabaseSync, conversation: number, minutes: number | null, at?: string): number {
  return transaction(db, () => {
    validId(conversation, 'conversation');
    if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > MUTE_MAX_MINUTES)) throw new TicketError('ticket.invalid-input', `Mute minutes must be 0..${MUTE_MAX_MINUTES} or null`);
    const until = minutes === null ? MUTE_FOREVER : minutes === 0 ? null : utc(new Date(Date.parse(utc(at)) + minutes * 60_000).toISOString());
    if (db.prepare('UPDATE conversation SET muted_until=? WHERE id=?').run(until, conversation).changes === 0) {
      throw new TicketError('ticket.not-found', `Conversation ${conversation} not found`);
    }
    return conversation;
  });
}

export function muteBatch(db: DatabaseSync, batch: number, minutes: number | null, at?: string): number {
  return transaction(db, () => mute(db, getBatch(db, batch).conversation, minutes, at));
}

export function muteTicket(db: DatabaseSync, ticket: number, minutes: number | null, at?: string): number[] {
  return transaction(db, () => {
    getTicket(db, ticket);
    return db.prepare("SELECT conversation FROM ticket_conversation WHERE ticket=? AND kind IN ('primary','linked') ORDER BY conversation").all(ticket)
      .map((row) => mute(db, Number(row.conversation), minutes, at));
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

export function makeTicket(db: DatabaseSync, batch: number, at?: string, actor: 'you' | 'chat' = 'you', cfg?: Pick<Config, 'clients'>): number {
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
      // The client the input names, else the client of the chat's latest ticket: the ticket keeps its client's chat folder
      const inferred = cfg ? batchClients(db, cfg, batch) : [];
      const earlier = db.prepare(`SELECT t.client FROM ticket_conversation l JOIN ticket t ON t.id=l.ticket
        WHERE l.conversation=? AND t.client IS NOT NULL ORDER BY t.id DESC LIMIT 1`).get(row.conversation)?.client as string | undefined;
      const client = inferred.length === 1 ? inferred[0]! : earlier && (!inferred.length || inferred.includes(earlier)) ? earlier : null;
      const id = Number(db.prepare('INSERT INTO ticket(title,client,summary,created_at,last_activity_at) VALUES (?,?,?,?,?)')
        .run(row.title || '(no title)', client, summary, now, now).lastInsertRowid);
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

export const newTicketSchema = z.strictObject({
  title: z.string().trim().min(1).max(200), client: z.string().min(1),
  summary: z.string().trim().max(4_000).default(''), ask: z.string().trim().max(2_000).default(''),
  proposal: z.string().trim().max(4_000).default(''),
  kb_notes: z.array(z.string().refine(isNotePath, 'Unsafe relative Markdown note path')).max(20).default([]),
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, 'Key is 1-80 letters, digits, dot, dash or underscore').optional(),
  initiative: z.string().min(1).optional(),
  origin: z.literal('ai').optional(),
  // A question Antonio already put: the ticket starts in Waiting on them, with no chat until something opens one
  waiting: z.object({ who: z.string().trim().min(1).max(40).regex(/^[^:]+$/, 'who has no colon'), what: z.string().trim().min(1).max(200),
    since: z.iso.date() }).optional(),
});
export type NewTicket = z.input<typeof newTicketSchema>;
export type Waiting = NonNullable<z.output<typeof newTicketSchema>['waiting']>;

// A wait is active and approved without a chat; its STATUS-shaped line "<who>: <what>" is what the Overview map reads.
// since: the day the question went out, the start of the waiting days
function setWaiting(db: DatabaseSync, ticket: number, waiting: Waiting, now: string): void {
  db.prepare(`UPDATE ticket SET lifecycle='active',approved_at=?,approval_note='',report='waiting_them',report_line=?,report_at=?,last_activity_at=? WHERE id=?`)
    .run(now, `${waiting.who}: ${waiting.what}`, utc(`${waiting.since}T12:00:00Z`), now, ticket);
}

// A ticket from Antonio's own plan rather than from a message: proposed, no conversation, no chat until approved.
// key makes a scripted run repeatable: the same key returns the ticket it made the first time.
// initiative: the Overview initiative it belongs to, of the same client; it then shows on the Overview, not on the board.
// origin 'ai': the AI suggested it; its initiative shows it in the AI column until it is started.
// waiting: it is a wait, not work to start (see setWaiting).
export function createTicket(db: DatabaseSync, cfg: Pick<Config, 'clients' | 'initiatives'>, input: unknown, at?: string, actor: 'you' | 'chat' = 'you'): number {
  const parsed = newTicketSchema.safeParse(input);
  if (!parsed.success) throw new TicketError('ticket.invalid-input', parsed.error.message);
  const fields = parsed.data;
  // An initiative names its own client, which need not have a [clients.<name>] entry
  if (fields.initiative !== undefined) {
    if (cfg.initiatives[fields.initiative]?.client !== fields.client) throw new TicketError('ticket.invalid-input', `Unknown initiative ${fields.initiative} for client ${fields.client}`);
  } else if (!Object.hasOwn(cfg.clients, fields.client)) throw new TicketError('ticket.invalid-input', `Unknown configured client ${fields.client}`);
  return transaction(db, () => {
    const now = utc(at);
    const key = fields.key ? `create:${fields.key}` : null;
    const made = key ? db.prepare('SELECT ticket FROM timeline WHERE event_key=?').get(key) : undefined;
    if (made) return Number(made.ticket);
    const id = Number(db.prepare(`INSERT INTO ticket(title,client,summary,ask,proposal,kb_notes,initiative,origin,created_at,last_activity_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(fields.title, fields.client, fields.summary, fields.ask, fields.proposal, JSON.stringify(fields.kb_notes),
      fields.initiative ?? null, fields.origin ?? null, now, now).lastInsertRowid);
    if (fields.waiting) setWaiting(db, id, fields.waiting, now);
    history(db, id, now, 'comment', actor, fields.waiting ? `Waiting on ${fields.waiting.who} since ${fields.waiting.since}${fields.origin === 'ai' ? ', found by AI' : ''}`
      : fields.origin === 'ai' ? 'Suggested by AI' : 'Created by hand', key ?? `create:ticket:${id}`);
    return id;
  });
}

// A proposed ticket that cannot move until an answer already asked for becomes a wait, keeping its number and its own
// texts. question: the ticket is only that question; it takes the wait's title, and when another ticket already holds
// the wait it is the same question, dismissed as such. Other work waits on the same answer while that ticket still
// waits. key: the wait's key, held by the first ticket to wait on it. Returns the ticket that holds or joins the wait,
// or null when nothing changed.
export function becomeWait(db: DatabaseSync, ticket: number, wait: { waiting: Waiting; title: string; question: boolean }, key: string, at?: string): number | null {
  return transaction(db, () => {
    const now = utc(at);
    const row = getTicket(db, ticket);
    if (row.lifecycle !== 'proposed' || row.approved_at || row.merged_into) return null;
    const held = db.prepare('SELECT ticket FROM timeline WHERE event_key=?').get(`create:${key}`);
    if (held && wait.question) {
      finishTicket(db, ticket, 'dismissed', `Already asked: same as wait #${held.ticket}`, now, 'agent');
      return Number(held.ticket);
    }
    if (held) {
      const holder = getTicket(db, Number(held.ticket));
      if (holder.lifecycle !== 'active' || holder.report !== 'waiting_them') return null;
    }
    history(db, ticket, now, 'comment', 'agent', `Already asked: now waiting on ${wait.waiting.who} since ${wait.waiting.since}`, held ? `wait:${key}:ticket:${ticket}` : `create:${key}`);
    if (wait.question) db.prepare('UPDATE ticket SET title=? WHERE id=?').run(wait.title, ticket);
    setWaiting(db, ticket, wait.waiting, now);
    return ticket;
  });
}

// The answer to a wait showed up outside its chat (the initiative's log): the ticket moves to Needs you with it, and
// Antonio reads it and closes or goes on. Only a wait with no chat: a chat reports its own ticket. key: one move per answer.
export function waitAnswered(db: DatabaseSync, ticket: number, line: string, key: string, at?: string): boolean {
  return transaction(db, () => {
    const now = utc(at);
    const row = getTicket(db, ticket);
    if (row.lifecycle !== 'active' || row.report !== 'waiting_them' || row.session_id) return false;
    if (!history(db, ticket, now, 'status', 'agent', line, `answered:${key}`)) return false;
    db.prepare("UPDATE ticket SET report='needs_you',report_line=?,report_at=?,last_activity_at=? WHERE id=?").run(line, now, now, ticket);
    return true;
  });
}

// Reason of the dismissals made when Antonio's own reply settled a proposed ticket (no longer automatic); kept out of triage feedback
export const ANSWERED_MYSELF = 'Answered myself in the source chat';

export function feedback(db: DatabaseSync) {
  const reasons = db.prepare("SELECT ticket,body AS reason,at FROM timeline WHERE event_key LIKE 'dismiss:ticket:%' AND body IS NOT ? ORDER BY id").all(ANSWERED_MYSELF)
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

const excludedProjects = new Set(['UTF', 'ISO', 'SHA', 'RFC', 'TLS', 'SSL', 'AES', 'RSA', 'HTTP', 'WIN', 'COVID', 'CVE', 'GPT', 'PCI', 'MD', 'PR', 'SSH']);

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
    ['snow', /\b(?:INC|CHG|RITM|SCTASK|CTASK|TASK|PRB|REQ)\d+\b/gi],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      if (kind === 'jira' && excludedProjects.has(match[1]!.toUpperCase())) continue;
      const url = urls.find((entry) => match.index >= entry.start && match.index < entry.end)?.url.href ?? null;
      // Jira writes keys in capitals; a lower-case word-dash-number in prose (node-20, rhel-9) is no key
      if (kind === 'jira' && !url && match[1] !== match[1]!.toUpperCase()) continue;
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
