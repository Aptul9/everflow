import type { Lifecycle } from '../core/types.ts';
import type { Stage, TicketRef } from '../core/tickets.ts';
import type { ModelChoice, ModelOptions } from '../core/settings.ts';

export const groups = [
  ['needs_you', 'Needs you'], ['working', 'Working'], ['waiting_them', 'Waiting on them'],
  ['failed', 'Failed'], ['done_today', 'Done'], ['skipped', 'Skipped'],
] as const;
export type Group = (typeof groups)[number][0];

export interface SourceMessage {
  id: number;
  source: string;
  sender: string | null;
  sent_at: string;
  text: string | null;
  // url: this page's address of the bytes (Teams relay images and files), null when the source keeps only the name
  attachments: { name: string; kind: 'image' | 'file'; url: string | null }[];
}

export interface Reference extends TicketRef { id: number }

export interface TicketCard {
  id: number;
  title: string;
  client: string | null;
  lifecycle: Lifecycle;
  stage: Stage;
  summary: string;
  ask: string;
  proposal: string;
  confidence: number | null;
  maybe_ticket: number | null;
  kb_notes: string[];
  // 'ai' when the AI suggested the ticket; an initiative shows it in its AI column until it is started
  origin: 'ai' | null;
  created_at: string;
  last_activity_at: string | null;
  closed_at: string | null;
  report: string | null;
  report_line: string | null;
  session_id: string | null;
  chat_running: boolean;
  // Approved input not yet sent to the chat, queued since then; null when nothing waits
  chat_waiting_since: string | null;
  session_title: string | null;
  // triage's reason (the latest triage timeline entry); AI tickets carry why instead
  reason: string | null;
  // Why the AI proposed it, with the note sections (S) and log entries (L) it cites; null on other and older tickets
  why: { text: string; sources: { id: string; kind: 'log' | 'section'; date?: string; text: string }[] } | null;
  // 'overview_chat' when the client's Overview chat dismissed it; restorable: Ripristina puts it back among the proposals
  dismissed_by: 'overview_chat' | null;
  restorable: boolean;
  timeline_revision: string;
  messages: SourceMessage[];
  refs: Reference[];
}

export interface TicketDetail {
  ticket: TicketCard;
  messages: SourceMessage[];
  refs: Reference[];
  timeline: { id: number; at: string; kind: string; actor: string; body: string; link: string | null }[];
}

export interface Health {
  dependency: string;
  scope: 'daemon' | 'source' | 'account' | 'provider' | 'openchamber' | 'jobs';
  state: 'ok' | 'retrying' | 'failing' | 'stopped' | 'unknown' | 'disabled';
  since: string | null;
  last_ok: string | null;
  last_error: string | null;
  checkpoint?: string | null;
  coverage?: 'recent-topics' | 'saved-history-replay';
  observed_at?: string;
  // Triage accounts on Meridian: share of the 5-hour and 7-day windows used, 0..1
  usage?: { five_hour?: number; seven_day?: number };
  // Account rows: paused on the page, batches held while paused, configured clients the account belongs to
  paused?: boolean;
  waiting?: number;
  clients?: string[];
}

export interface ParkedJob {
  id: number;
  kind: string;
  ticket: number | null;
  last_error: string | null;
  updated_at: string;
  raw: string | null;
  parse_error: string | null;
}

export interface SkippedBatch {
  id: number;
  title: string | null;
  source: string;
  account: string;
  outcome: 'not_on_us' | 'backlog' | 'answered' | 'muted';
  created_at: string;
  reason: string | null;
  messages: SourceMessage[];
}

// A batch waiting for or in triage, shown before its ticket exists
export interface TriageBatch {
  id: number;
  title: string | null;
  source: string;
  account: string;
  created_at: string;
  job: 'queued' | 'running' | 'parked' | null;
  // Configured clients the batch belongs to; held while its account is paused
  clients: string[];
  held: boolean;
  messages: SourceMessage[];
}

// An agent running right now: a triage call or a ticket chat turn
export interface Agent {
  kind: 'triage' | 'chat';
  clients: string[];
  title: string | null;
  ticket: number | null;
}

export interface MutedConversation {
  id: number;
  title: string | null;
  source: string;
  account: string;
  until: string;
  forever: boolean;
}

export interface OverviewState {
  tickets_enabled: boolean;
  chats_enabled: boolean;
  day: string;
  groups: Record<Group, TicketCard[]>;
  // Tickets of each Overview initiative, by board column; they are not in groups. Finished cards stay 7 days
  initiatives: Record<string, Record<Group, TicketCard[]>>;
  skipped: SkippedBatch[];
  triaging: TriageBatch[];
  agents: Agent[];
  // Model and effort the next triage call and the next new ticket chat use, and what the pickers can offer.
  // triage_routes: providers triage tries in order, so the account its model runs on
  models: { triage: ModelChoice; chat: ModelChoice; options: ModelOptions; triage_routes: string[] };
  // Folder name of the OpenChamber project that holds ticket chats, and per client where it has its own
  chat_project: string;
  chat_projects?: Record<string, string>;
  // [web] chat_origin: the OpenChamber web UI behind this page's sign-in; absent, chats open only in the app
  chat_origin?: string;
  muted: MutedConversation[];
  health: Health[];
  problems: {
    jobs: ParkedJob[];
    quarantine: { id: number; source: string; line: string; error: string; at: string; truncated: boolean }[];
    triage: { id: number; batch: number | null; at: string; raw: string | null; parse_error: string | null }[];
  };
  feedback: { make_ticket_count: number; dismiss_count: number; dismiss_reasons: { ticket: number; reason: string; at: string }[] };
}

// A file a ticket chat wrote or edited on the daemon's machine, shown beside the chat. touched: when the chat last wrote,
// edited or named it; mtime: the file's own last change.
export type ChatFileKind = 'markdown' | 'text' | 'docx' | 'pptx' | 'odt' | 'odp' | 'workbook' | 'pdf' | 'image' | 'other';
export interface ChatFile { path: string; name: string; size: number; mtime: string; kind: ChatFileKind; touched: string }

// Overview page: an initiative summed up from its vault note. Every line keeps the log entries or tickets it rests on.
export interface InitiativeSource { id: string; date: string; text: string }
export interface InitiativeLine { text: string; sources: InitiativeSource[] }
// owes them: that person owes Antonio or the work; owes you: Antonio owes them. since: the day it began, days: working days since
export interface InitiativeWait extends InitiativeLine { who: string; owes: 'you' | 'them'; since: string; days: number }
export type InitiativeStateName = 'moving' | 'waiting_them' | 'needs_you' | 'stuck' | 'quiet';
export interface InitiativeSummary {
  state: InitiativeStateName; headline: string; now: InitiativeLine[];
  // rejected: lines dropped for citing no offered source; entries: log entries offered
  rejected: number; entries: number; model: string;
}
// waits: one per ticket of the initiative waiting on someone, who from its STATUS line "<who>: <text>"
export interface InitiativeView {
  id: string; title: string; client: string; note: string; at: string | null; summary: InitiativeSummary | null; error: string | null; error_at: string | null;
  waits: InitiativeWait[];
}
export interface InitiativesState {
  initiatives: InitiativeView[]; today: string; views: Record<string, number>; requested: boolean; refreshing: boolean; providers: boolean;
}
// The client's chat of the day on the Overview and the guide: opened (created at the first open of the day), and its state
export interface ClientChatOpen { client: string; day: string; session_id: string; directory: string }
export interface ClientChatStatus { client: string; day: string; session_id: string | null; running: boolean }
// Cookie of the initiative last opened on the Overview: the server reads it, so the page reopens on it after the board, a guide or a reload
export const OVERVIEW_COOKIE = 'everflow_overview';
// Initiative guide (/overview/<id>): a plain-language explainer of one initiative, written in Italian from its vault note and
// related notes. Every fact cites source ids (L = log entry, S = note section, N = related note, T = ticket); general
// explanations (concepts, glossary) may cite none and carry general: true. sources holds only the ids cited.
export interface ExplainerSource { id: string; kind: 'log' | 'section' | 'note' | 'ticket'; date?: string; text: string }
export type ExplainerDiagramKind = 'flow' | 'nest' | 'split' | 'hub' | 'row' | 'one';
export interface ExplainerDiagram { t: ExplainerDiagramKind; i: string[]; hi?: number; b?: string }
export interface ExplainerTeam { id: string; name: string; plain: string; kind: 'client' | 'us' | 'platform' | 'security' | 'vendor' | 'other'; people: string[] }
export interface ExplainerPerson { id: string; name: string; short: string; team: string; role: string; plain: string; ask_for: string; how: string; src: string[] }
// say: optional key sentence, empty when the concept needs none (most concepts); diagram only when a drawing adds something
export interface ExplainerConcept { id: string; title: string; plain: string; analogy: string; say: string; diagram: ExplainerDiagram | null; src: string[] }
// Icons a glossary entry may carry: lucide icon names, rendered only when they say what the term is
export const EXPLAINER_ICONS = ['vault', 'key-round', 'lock', 'shield', 'shield-alert', 'fingerprint', 'users', 'user', 'bot', 'server', 'database', 'cloud', 'container',
  'network', 'git-branch', 'git-pull-request', 'ticket', 'file-text', 'book-open', 'bell', 'siren', 'scroll-text', 'clipboard-check', 'list-checks', 'terminal', 'monitor',
  'workflow', 'refresh-cw', 'eye', 'building-2'] as const;
export type ExplainerIcon = (typeof EXPLAINER_ICONS)[number];
export interface ExplainerTerm { id: string; term: string; aliases: string[]; short: string; long: string; diagram: ExplainerDiagram | null; icon?: ExplainerIcon | null; general: boolean; src: string[] }
export type ExplainerItemStatus = 'done' | 'doing' | 'todo' | 'blocked';
export interface ExplainerPhase { id: string; title: string; plain: string; items: { title: string; status: ExplainerItemStatus; note: string; src: string[] }[] }
// Graph: owes = a person (or "you") owes a node; unblocks = a node makes the next node (or "goal") possible
export interface ExplainerNode { id: string; kind: 'task' | 'deliverable' | 'decision' | 'answer'; label: string; plain: string; status: 'open' | 'done' | 'blocked'; owner: string; since: string | null; src: string[] }
export interface ExplainerEdge { from: string; to: string; kind: 'owes' | 'unblocks'; why: string; src: string[] }
export interface Explainer {
  title: string; one_liner: string; why: string[]; role: string;
  teams: ExplainerTeam[]; people: ExplainerPerson[]; concepts: ExplainerConcept[]; glossary: ExplainerTerm[];
  warnings: { title: string; text: string; src: string[] }[];
  ask_who: { need: string; who: string; how: string }[];
  phases: ExplainerPhase[];
  timeline: { date: string; title: string; plain: string; src: string[] }[];
  goal: { label: string; plain: string };
  graph: { nodes: ExplainerNode[]; edges: ExplainerEdge[] };
  blocked_by: { title: string; plain: string; who: string; since: string | null; node: string | null; src: string[] }[];
  next_you: { text: string; why: string; src: string[] }[];
  sources: Record<string, ExplainerSource>;
  // notes read besides the main note, items dropped for citing nothing valid, model that wrote it
  notes: string[]; rejected: number; model: string;
  // what the check after generation fixed by itself (dates, ids, paths) and the items it dropped; absent on older guides
  checks?: { fixed: number; dropped: string[] };
}
// What the guide page gets: the initiative (with its summary), the stored guide and its run state
export interface GuideState {
  initiative: InitiativeView; today: string;
  at: string | null; explainer: Explainer | null; error: string | null; error_at: string | null;
  requested: boolean; running: boolean; providers: boolean;
  // next_you items Antonio hid, as guideItemKey of their text
  dismissed: string[];
  // guide texts Antonio flagged as wrong, as guideItemKey of their text
  flagged: string[];
}

// Stable key of a guide item text, so a hidden step stays hidden across reloads and changes of spacing or case
export function guideItemKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
}

// Dates as Italians write them: 2026-10-27 -> 27/10/2026, 10-27 -> 27/10. Code spans are left alone.
export function italianDates(text: string): string {
  return text.split(/(`[^`\n]+`)/).map((part, index) => index % 2 ? part : part
    .replace(/(?<![\d\-/.])(\d{4})-(\d{2})-(\d{2})(?![\d\-/])/g, '$3/$2/$1')
    .replace(/(?<![\p{L}\d\-/.:])(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?![\d\-/])/gu, '$2/$1')).join('');
}

// Text without what only a machine reads: Teams chat and thread ids, staff ids, local paths, note file names, uuids
export function stripNoise(text: string): string {
  return text
    .replace(/(?:\b(?:meeting\s+)?chat\s+)?[(`]?19:[^\s@`]+@thread\.[a-z0-9]+[)`]?[,;:]?\s*/gi, '')
    .replace(/[,;]?\s*\b(?:transcript|file)?\s*`(?:[A-Za-z]:[\\/]|~\/|\/home\/|Downloads\/)[^`]*`/gi, '')
    .replace(/\s*(?<![\w-])[A-Z]{2}\d{7,9}\b/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/(?<![\w`])(?:[A-Za-z]:\\|~\/|\/home\/)[^\s`,;)]+/g, '')
    .replace(/(?<![\w/`-])[\w-]+\.md\b/g, '')
    .replace(/\(\s*\)/g, '').replace(/\s+([,.;:])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

// A cited source as a person reads it: no leading log date (shown apart) and none of the noise above
export function cleanSourceText(text: string): string {
  const out = stripNoise(text.replace(/^\d{4}-\d{2}-\d{2}[^\n]{0,30}?\s-\s/, '').replace(/^[\w./-]+\.md\s+·\s+/, ''));
  return italianDates(out.charAt(0).toUpperCase() + out.slice(1));
}
