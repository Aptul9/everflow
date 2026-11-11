import type { Lifecycle } from '../dispatcher/types.ts';
import type { Stage, TicketRef } from '../dispatcher/tickets.ts';
import type { ModelChoice, ModelOptions } from '../dispatcher/settings.ts';

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
  // Model and effort the next triage call and the next new ticket chat use, and what the pickers can offer
  models: { triage: ModelChoice; chat: ModelChoice; options: ModelOptions };
  // Folder name of the OpenChamber project that holds ticket chats, and per client where it has its own
  chat_project: string;
  chat_projects?: Record<string, string>;
  muted: MutedConversation[];
  health: Health[];
  problems: {
    jobs: ParkedJob[];
    quarantine: { id: number; source: string; line: string; error: string; at: string; truncated: boolean }[];
    triage: { id: number; batch: number | null; at: string; raw: string | null; parse_error: string | null }[];
  };
  feedback: { make_ticket_count: number; dismiss_count: number; dismiss_reasons: { ticket: number; reason: string; at: string }[] };
}
