import type { Lifecycle } from '../dispatcher/types.ts';
import type { Stage, TicketRef } from '../dispatcher/tickets.ts';

export const groups = [
  ['needs_you', 'Needs you'], ['working', 'Working'], ['waiting_them', 'Waiting on them'],
  ['failed', 'Failed'], ['done_today', 'Done today'], ['skipped', 'Skipped'],
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
  muted: MutedConversation[];
  health: Health[];
  problems: {
    jobs: ParkedJob[];
    quarantine: { id: number; source: string; line: string; error: string; at: string; truncated: boolean }[];
    triage: { id: number; batch: number | null; at: string; raw: string | null; parse_error: string | null }[];
  };
  feedback: { make_ticket_count: number; dismiss_count: number; dismiss_reasons: { ticket: number; reason: string; at: string }[] };
}
