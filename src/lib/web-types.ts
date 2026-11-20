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
  reason: string | null;
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
export type ChatFileKind = 'markdown' | 'text' | 'docx' | 'pdf' | 'image' | 'other';
export interface ChatFile { path: string; name: string; size: number; mtime: string; kind: ChatFileKind; touched: string }

// Overview page: an initiative summed up from its vault note. Every line keeps the log entries or tickets it rests on.
export interface InitiativeSource { id: string; date: string; text: string }
export interface InitiativeLine { text: string; sources: InitiativeSource[] }
// owes them: that person owes Antonio or the work; owes you: Antonio owes them. since: date of the oldest source, days: working days since
export interface InitiativeWait extends InitiativeLine { who: string; owes: 'you' | 'them'; since: string; days: number }
export interface InitiativeNext extends InitiativeLine { owner: 'ai' | 'you'; draft: string | null }
export type InitiativeStateName = 'moving' | 'waiting_them' | 'needs_you' | 'stuck' | 'quiet';
export interface InitiativeSummary {
  state: InitiativeStateName; headline: string; now: InitiativeLine[]; waits: InitiativeWait[]; next: InitiativeNext[]; done: InitiativeLine[];
  // rejected: items dropped for citing no offered source; entries: log entries offered
  rejected: number; entries: number; model: string;
}
export interface InitiativeView {
  id: string; title: string; client: string; note: string; at: string | null; summary: InitiativeSummary | null; error: string | null; error_at: string | null;
}
export interface InitiativesState {
  initiatives: InitiativeView[]; today: string; views: Record<string, number>; requested: boolean; refreshing: boolean; providers: boolean;
}