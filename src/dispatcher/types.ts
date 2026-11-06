export type Lifecycle = 'proposed' | 'active' | 'done' | 'dismissed';
export type Report = 'working' | 'needs_you' | 'waiting_them' | 'blocked' | 'done';
export type JobState = 'queued' | 'running' | 'done' | 'parked' | 'cancelled';
export type TurnKind = 'brief' | 'forward' | 'recovery' | 'note';
export type ErrorClass = 'dependency' | 'job' | 'unknown';
export type JobKind = 'triage' | 'start_chat' | 'forward' | 'collect' | 'sync' | 'archive' | 'purge';

export interface DaemonDetail {
  store_id: string;
  triage_after: string;
  first_started_at: string;
  run_id?: string;
  pid?: number;
}
