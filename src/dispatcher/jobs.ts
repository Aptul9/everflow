import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { openDb, transaction } from './db.ts';
import { utc } from './time.ts';
import type { ErrorClass, JobKind, JobState } from './types.ts';

export type JobPayload = Record<string, unknown>;
export type RetryAfter = number | string | null | undefined;
export type BackoffPolicy = Pick<Config['jobs'], 'backoff_initial_seconds' | 'backoff_max_seconds' | 'backoff_jitter'>;

export interface Failure {
  error_class: ErrorClass;
  message: string;
  retry_after: RetryAfter;
}

export interface Job {
  id: number;
  kind: JobKind;
  key: string;
  ticket: number | null;
  payload: JobPayload;
  state: JobState;
  attempts: number;
  failures: number;
  next_at: string;
  lease_until: string | null;
  lease_token: string | null;
  run_id: string | null;
  lease_seconds: number | null;
  reserved_at: string | null;
  turn_id: number | null;
  merged_into: number | null;
  error_class: ErrorClass | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function readJob(db: DatabaseSync, id: number): Job {
  const row = db.prepare('SELECT * FROM job WHERE id=?').get(id)!;
  return { ...row, payload: JSON.parse(String(row.payload)) } as unknown as Job;
}

function afterSeconds(at: string, seconds: number): string {
  const stamp = utc(at);
  const micros = BigInt(Date.parse(stamp)) * 1000n + BigInt(stamp.slice(23, 26)) + BigInt(Math.ceil(seconds * 1_000_000));
  const remainder = (micros % 1000n + 1000n) % 1000n;
  return utc(new Date(Number((micros - remainder) / 1000n)).toISOString().replace('Z', `${String(remainder).padStart(3, '0')}Z`));
}

const fence = "id=? AND state='running' AND lease_token=? AND run_id=? AND lease_until>?";

export function owns(db: DatabaseSync, job: Job, at: string): boolean {
  return db.prepare(`SELECT 1 FROM job WHERE ${fence}`).get(job.id, job.lease_token, job.run_id, at) !== undefined;
}

function payloadText(payload: JobPayload): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Job payload must be a JSON object');
  const text = JSON.stringify(payload, (_key, value: unknown) => {
    if (value === undefined || ['function', 'symbol', 'bigint'].includes(typeof value)
      || typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Job payload must contain only JSON values');
    return value;
  });
  const saved: unknown = JSON.parse(text);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new TypeError('Job payload must be a JSON object');
  return text;
}

function batchIds(value: unknown, field: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new TypeError(`Invalid ${field}`);
  return [...new Set(value as number[])];
}

function forwardPayload(payload: JobPayload): JobPayload {
  const batches = batchIds(payload.batch_ids, 'batch_ids');
  const result: JobPayload = { ...payload, batch_ids: batches };
  if (payload.pending_batch_ids !== undefined) {
    result.pending_batch_ids = batchIds(payload.pending_batch_ids, 'pending_batch_ids').filter((id) => !batches.includes(id));
  }
  return result;
}

function mergeForward(db: DatabaseSync, head: Job, incoming: JobPayload, at: string): void {
  const batches = batchIds(head.payload.batch_ids, 'batch_ids');
  const tail = [...new Set([...batchIds(head.payload.pending_batch_ids, 'pending_batch_ids'),
    ...batchIds(incoming.batch_ids, 'batch_ids'), ...batchIds(incoming.pending_batch_ids, 'pending_batch_ids')])];
  let payload: JobPayload;
  if (head.turn_id !== null) payload = { ...head.payload, pending_batch_ids: tail.filter((id) => !batches.includes(id)) };
  else {
    const { pending_batch_ids: _pending, ...saved } = head.payload;
    payload = { ...saved, batch_ids: [...new Set([...batches, ...tail])] };
  }
  db.prepare('UPDATE job SET payload=?,updated_at=? WHERE id=?').run(payloadText(payload), at, head.id);
}

export function enqueue(db: DatabaseSync, kind: JobKind, key: string, payload: JobPayload, ticket?: number): number {
  const at = utc();
  const incoming = JSON.parse(payloadText(payload)) as JobPayload;
  const normalized = kind === 'forward' ? forwardPayload(incoming) : incoming;
  return transaction(db, () => {
    const existing = db.prepare('SELECT id,kind,ticket,merged_into FROM job WHERE key=?').get(key);
    if (existing) {
      if (existing.kind !== kind || existing.ticket !== (ticket ?? null)) throw new Error(`Job key ${key} belongs to different work`);
      const target = readJob(db, Number(existing.merged_into ?? existing.id));
      if (kind === 'forward' && target.state === 'parked') mergeForward(db, target, normalized, at);
      return target.id;
    }
    const parked = kind === 'forward' && ticket !== undefined
      ? db.prepare("SELECT id FROM job WHERE kind='forward' AND ticket=? AND state='parked' ORDER BY id LIMIT 1").get(ticket) : undefined;
    const target = parked ? Number(parked.id) : null;
    const saved = db.prepare(`INSERT INTO job(kind,key,ticket,payload,state,merged_into,next_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(kind, key, ticket ?? null, payloadText(normalized), target === null ? 'queued' : 'cancelled', target, at, at, at);
    if (target !== null) mergeForward(db, readJob(db, target), normalized, at);
    return target ?? Number(saved.lastInsertRowid);
  });
}

export function claim(db: DatabaseSync, cfg: Config, runId: string, at?: string): Job | null {
  if (!runId) throw new TypeError('A nonempty run id is required');
  return transaction(db, () => {
    const now = utc(at);
    db.prepare(`UPDATE job SET state='queued',lease_until=NULL,lease_token=NULL,run_id=NULL,updated_at=?
      WHERE state='running' AND lease_until<=?`).run(now, now);
    const triage = Number(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='triage' AND state='running'").get()!.n);
    const slots = reservations(db);
    const row = db.prepare(`SELECT j.id FROM job j WHERE j.state='queued' AND j.next_at<=?
      AND NOT EXISTS (SELECT 1 FROM job earlier WHERE earlier.ticket=j.ticket AND earlier.id<j.id
        AND earlier.state IN ('queued','running','parked'))
      AND (j.kind<>'triage' OR ?<?)
      AND (j.kind NOT IN ('start_chat','forward') OR j.reserved_at IS NOT NULL OR j.turn_id IS NOT NULL OR ?<?)
      ORDER BY j.id LIMIT 1`).get(now, triage, cfg.jobs.triage_concurrency, slots, cfg.jobs.turn_concurrency);
    if (!row) return null;
    const id = Number(row.id);
    db.prepare(`UPDATE job SET state='running',lease_until=?,lease_token=?,run_id=?,lease_seconds=?,updated_at=?,
      reserved_at=CASE WHEN kind IN ('start_chat','forward') AND turn_id IS NULL THEN COALESCE(reserved_at,?) ELSE reserved_at END WHERE id=?`)
      .run(afterSeconds(now, cfg.jobs.lease_seconds), randomUUID(), runId, cfg.jobs.lease_seconds, now, now, id);
    return readJob(db, id);
  });
}

export function renew(db: DatabaseSync, id: number, leaseToken: string, at?: string): boolean {
  return transaction(db, () => {
    const now = utc(at);
    const row = db.prepare("SELECT lease_seconds FROM job WHERE id=? AND state='running' AND lease_token=? AND lease_until>?")
      .get(id, leaseToken, now);
    if (!row || typeof row.lease_seconds !== 'number' || row.lease_seconds <= 0) return false;
    db.prepare('UPDATE job SET lease_until=?,updated_at=? WHERE id=?')
      .run(afterSeconds(now, Number(row.lease_seconds)), now, id);
    return true;
  });
}

const leaseLost = Symbol('lease lost');

export function complete(db: DatabaseSync, job: Job, effects: (db: DatabaseSync) => void): boolean {
  try {
    return transaction(db, () => {
      if (!owns(db, job, utc())) return false;
      const result: unknown = effects(db);
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new TypeError('Completion effects must be synchronous');
      }
      const now = utc();
      const updated = db.prepare(`UPDATE job SET state='done',lease_until=NULL,lease_token=NULL,run_id=NULL,reserved_at=NULL,updated_at=? WHERE ${fence}`)
        .run(now, job.id, job.lease_token, job.run_id, now);
      if (!updated.changes) throw leaseLost;
      return true;
    });
  } catch (error) {
    if (error === leaseLost) return false;
    throw error;
  }
}

export function defer(db: DatabaseSync, job: Job, nextAt: string, payload?: JobPayload): boolean {
  const next = utc(nextAt);
  const saved = payload === undefined ? null : payloadText(payload);
  return transaction(db, () => {
    const now = utc();
    return db.prepare(`UPDATE job SET state='queued',next_at=?,payload=COALESCE(?,payload),lease_until=NULL,lease_token=NULL,
      run_id=NULL,updated_at=? WHERE ${fence}`)
      .run(next, saved, now, job.id, job.lease_token, job.run_id, now).changes !== 0;
  });
}

export function retry(db: DatabaseSync, id: number): void {
  const now = utc();
  const changed = db.prepare(`UPDATE job SET state='queued',attempts=0,failures=0,error_class=NULL,last_error=NULL,next_at=?,
    lease_until=NULL,lease_token=NULL,run_id=NULL,updated_at=? WHERE id=? AND state='parked'`).run(now, now, id).changes;
  if (!changed) throw new Error(`Job ${id} is not parked`);
}

export function park(db: DatabaseSync, id: number, reason: string): void {
  const job = readJob(db, id);
  if (maintenance(job.kind)) throw new Error(`Cannot park maintenance job ${id}`);
  const changed = db.prepare(`UPDATE job SET state='parked',last_error=?,lease_until=NULL,lease_token=NULL,run_id=NULL,updated_at=?
    WHERE id=? AND state IN ('queued','running','parked')`).run(reason, utc(), id).changes;
  if (!changed) throw new Error(`Job ${id} cannot be parked`);
}

function records(error: unknown): Record<string, unknown>[] {
  const seen = new Set<unknown>();
  const queue = [error];
  const result: Record<string, unknown>[] = [];
  for (const value of queue) {
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    result.push(record);
    for (const key of ['cause', 'error', 'errors', 'data', 'detail', 'details', 'response']) queue.push(record[key]);
  }
  return result;
}

const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const programmingErrors = new Set(['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError']);

function errorMessage(error: unknown, nodes = records(error)): string {
  const message = nodes.find((node) => typeof node.message === 'string')?.message;
  if (typeof message === 'string') return message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function classify(error: unknown): Failure {
  const nodes = records(error);
  const freshSignIn = nodes.some((node) => node.fresh_sign_in === true || node.auth_refreshed === true);
  const session = nodes.some((node) => node.resource === 'session' || node.type === 'session.not-found');
  const statuses = nodes.flatMap((node) => [node.status, node.statusCode, node.status_code])
    .filter((value) => typeof value === 'number' || typeof value === 'string' && /^\d{3}$/.test(value)).map(Number);
  let errorClass: ErrorClass = 'unknown';
  if (nodes.some((node) => node.type === 'provider.no-route' || node.type === 'session.not-found'
    || node.type === 'model.invalid-decision' && node.repaired === true)) errorClass = 'job';
  else if (statuses.some((status) => status === 400 || status === 403 || status === 401 && freshSignIn || status === 404 && session)) errorClass = 'job';
  else if (statuses.some((status) => status === 408 || status === 429 || status >= 500 && status <= 599)) errorClass = 'dependency';
  else if (nodes.some((node) => {
    const code = String(node.code ?? '');
    const com = [node.code, node.hresult, node.errno].some((value) => {
      const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
      return Number.isInteger(number) && ((number >>> 0) === 0x800706BA || (number >>> 0) === 0x80010001);
    });
    const sqlite = typeof node.errcode === 'number' && ((node.errcode & 255) === 5 || (node.errcode & 255) === 6);
    return networkCodes.has(code) || /^SQLITE_(BUSY|LOCKED)(_|$)/.test(code) || com || sqlite
      || node.name === 'TimeoutError' || node.name === 'AbortError' || node.type === 'provider.transport';
  })) errorClass = 'dependency';
  else if (nodes.some((node) => programmingErrors.has(String(node.name)))) errorClass = 'job';

  let retryAfter: RetryAfter;
  for (const node of nodes) {
    const direct = node.retry_after ?? node.retryAfter;
    const headers = node.headers;
    const header = headers instanceof Headers ? headers.get('retry-after') : headers && typeof headers === 'object'
      ? Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1] : undefined;
    const value = direct ?? header;
    if (typeof value === 'number' || typeof value === 'string') {
      retryAfter = value;
      break;
    }
  }
  return { error_class: errorClass, message: errorMessage(error, nodes), retry_after: retryAfter };
}

// Delay is in seconds. Retry-After accepts delta seconds or an HTTP-date.
export function backoff(failures: number, policy: BackoffPolicy, retryAfter: RetryAfter, randomValue: number, at?: string): number {
  const initial = policy.backoff_initial_seconds;
  const cap = policy.backoff_max_seconds;
  const jitter = policy.backoff_jitter;
  if (!Number.isSafeInteger(initial) || initial <= 0 || !Number.isSafeInteger(cap) || cap < initial
    || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new RangeError('Invalid backoff policy');
  if (!Number.isSafeInteger(failures) || failures < 0) throw new RangeError('Invalid failures counter');
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) throw new RangeError('Invalid random value');
  let floor = 0;
  if (typeof retryAfter === 'number') {
    if (!Number.isFinite(retryAfter)) throw new RangeError('Invalid Retry-After seconds');
    floor = retryAfter;
  } else if (typeof retryAfter === 'string') {
    const value = retryAfter.trim();
    floor = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.parse(utc(at))) / 1000;
    if (!Number.isFinite(floor)) floor = 0;
  }
  const base = Math.min(cap, initial * 2 ** Math.min(Math.max(0, failures - 1), 30));
  return Math.max(Math.max(0, floor), Math.min(cap, base * (1 - jitter + 2 * jitter * randomValue)));
}

function maintenance(kind: JobKind): boolean {
  return kind === 'sync' || kind === 'archive' || kind === 'purge';
}

export function healthError(db: DatabaseSync, cfg: Config, dependency: string, error: unknown, at?: string, source = false): void {
  const now = utc(at);
  transaction(db, () => {
    const row = db.prepare('SELECT state,since,detail FROM health WHERE dependency=?').get(dependency);
    const detail = row ? JSON.parse(String(row.detail)) as Record<string, unknown> : {};
    const previous = Number.isSafeInteger(detail.consecutive_errors) && Number(detail.consecutive_errors) > 0
      ? Number(detail.consecutive_errors) : 0;
    const count = previous + 1;
    const state = source || count >= cfg.jobs.dependency_failure_threshold ? 'failing' : 'retrying';
    const since = previous && (row?.state === 'retrying' || row?.state === 'failing') ? String(row.since) : now;
    db.prepare(`INSERT INTO health(dependency,state,since,last_error,detail) VALUES (?,?,?,?,?)
      ON CONFLICT(dependency) DO UPDATE SET state=excluded.state,since=excluded.since,last_error=excluded.last_error,detail=excluded.detail`)
      .run(dependency, state, since, errorMessage(error), JSON.stringify({ ...detail, consecutive_errors: count }));
  });
}

export function healthOk(db: DatabaseSync, dependency: string, at?: string, detail: Record<string, unknown> = {}): void {
  const now = utc(at);
  transaction(db, () => {
    const row = db.prepare('SELECT detail FROM health WHERE dependency=?').get(dependency);
    const previous = row ? JSON.parse(String(row.detail)) as Record<string, unknown> : {};
    db.prepare(`INSERT INTO health(dependency,state,since,last_ok,detail) VALUES (?,'ok',?,?,?)
      ON CONFLICT(dependency) DO UPDATE SET state='ok',since=excluded.since,last_ok=excluded.last_ok,last_error=NULL,detail=excluded.detail`)
      .run(dependency, now, now, JSON.stringify({ ...previous, ...detail, consecutive_errors: 0 }));
  });
}

export interface FailOptions {
  dependency?: string;
  at?: string;
  randomValue?: number;
}

export function fail(db: DatabaseSync, cfg: Config, job: Job, error: unknown, options: FailOptions = {}): boolean {
  return transaction(db, () => {
    if (!owns(db, job, utc(options.at))) return false;
    const current = readJob(db, job.id);
    const failure = classify(error);
    const failures = current.failures + 1;
    const attempts = current.attempts + (failure.error_class === 'dependency' ? 0 : 1);
    const parked = !maintenance(current.kind) && (failure.error_class === 'job'
      || failure.error_class === 'unknown' && attempts >= cfg.jobs.max_attempts);
    const now = utc(options.at);
    const next = parked ? now : afterSeconds(now, backoff(failures, cfg.jobs, failure.retry_after, options.randomValue ?? Math.random(), now));
    const updated = db.prepare(`UPDATE job SET state=?,attempts=?,failures=?,next_at=?,error_class=?,last_error=?,lease_until=NULL,
      lease_token=NULL,run_id=NULL,updated_at=? WHERE ${fence}`)
      .run(parked ? 'parked' : 'queued', attempts, failures, next, failure.error_class, failure.message, now,
        job.id, job.lease_token, job.run_id, now);
    if (!updated.changes) return false;
    const dependency = options.dependency ?? (maintenance(current.kind) ? `jobs:${current.kind}` : undefined);
    if (dependency) healthError(db, cfg, dependency, failure.message, now);
    return true;
  });
}

function reservations(db: DatabaseSync): number {
  return Number(db.prepare(`SELECT
    (SELECT COUNT(*) FROM job WHERE reserved_at IS NOT NULL AND turn_id IS NULL) +
    (SELECT COUNT(*) FROM turn WHERE state IN ('admitted','running') OR state='prepared' AND reserved_at IS NOT NULL) AS n`).get()!.n);
}

export function reserveTurn(db: DatabaseSync, cfg: Config, job: Job, turnId: number, at?: string): boolean {
  return transaction(db, () => {
    const now = utc(at);
    if (!owns(db, job, now)) return false;
    const current = readJob(db, job.id);
    const turn = db.prepare('SELECT ticket,state,reserved_at FROM turn WHERE id=?').get(turnId);
    if (!turn || turn.ticket !== current.ticket) throw new Error('Turn must belong to the job ticket');
    if (current.turn_id !== null) {
      if (current.turn_id !== turnId) throw new Error(`Job ${job.id} is already bound to a different turn`);
      return true;
    }
    if (turn.state === 'done' || turn.state === 'cancelled') throw new Error('Cannot reserve a terminal turn');
    if (db.prepare('SELECT id FROM job WHERE turn_id=?').get(turnId)) throw new Error('Turn is already bound to another job');
    const held = current.reserved_at !== null || turn.reserved_at !== null || turn.state === 'admitted' || turn.state === 'running';
    if (!held && reservations(db) >= cfg.jobs.turn_concurrency) return false;
    db.prepare('UPDATE turn SET reserved_at=COALESCE(reserved_at,?) WHERE id=?').run(now, turnId);
    db.prepare(`UPDATE job SET turn_id=?,reserved_at=COALESCE(reserved_at,?),updated_at=? WHERE ${fence}`)
      .run(turnId, now, now, job.id, job.lease_token, job.run_id, now);
    return true;
  });
}

export interface Renewal extends Disposable {
  readonly lost: boolean;
  readonly error: unknown;
  stop(): void;
}

export function startRenewal(cfg: Config, job: Job, onLost?: (error: unknown) => void): Renewal {
  if (!job.lease_token || !job.run_id || job.state !== 'running') throw new TypeError('A claimed job is required for renewal');
  const db = openDb(cfg.db.path);
  let stopped = false;
  let lost = false;
  let error: unknown;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    db.close();
  };
  const timer = setInterval(() => {
    try {
      if (renew(db, job.id, job.lease_token!)) return;
      error = new Error(`Job ${job.id} lease lost`);
    } catch (failure) {
      error = failure;
    }
    lost = true;
    stop();
    onLost?.(error);
  }, cfg.jobs.renew_seconds * 1000);
  timer.unref();
  return { get lost() { return lost; }, get error() { return error; }, stop, [Symbol.dispose]: stop };
}
