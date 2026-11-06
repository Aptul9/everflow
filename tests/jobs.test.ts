import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/dispatcher/config.ts';
import { openDb, prepareStart } from '../src/dispatcher/db.ts';
import * as jobs from '../src/dispatcher/jobs.ts';
import { raceClaims, raceEnqueues } from './jobs-support.ts';
import { scratch } from './support.ts';

const AT = '2026-11-06T00:00:00.000000Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AT));
});

afterEach(() => vi.useRealTimers());

function fixture(policy: Partial<ReturnType<typeof loadConfig>['jobs']> = {}) {
  const files = scratch('phase2-');
  const cfg = loadConfig(files.config);
  Object.assign(cfg.jobs, policy);
  return { ...files, cfg };
}

function ticket(db: DatabaseSync, title = 'Synthetic ticket'): number {
  return Number(db.prepare('INSERT INTO ticket(title,created_at) VALUES (?,?)').run(title, AT).lastInsertRowid);
}

function row(db: DatabaseSync, id: number) {
  return db.prepare('SELECT * FROM job WHERE id=?').get(id)!;
}

function turn(db: DatabaseSync, owner: number, prompt: string, state = 'prepared', reservedAt: string | null = null): number {
  return Number(db.prepare(`INSERT INTO turn(ticket,kind,prompt_id,text,session_id,state,reserved_at,created_at)
    VALUES (?,'forward',?,'Immutable source input','synthetic-session',?,?,?)`).run(owner, prompt, state, reservedAt, AT).lastInsertRowid);
}

function clockAfterBegin(db: DatabaseSync, at: string): Disposable {
  const exec = db.exec;
  // Forward real SQLite calls, advancing only the clock at the acquired-writer boundary.
  db.exec = (sql: string) => {
    exec.call(db, sql);
    if (sql === 'BEGIN IMMEDIATE') vi.setSystemTime(new Date(at));
  };
  return { [Symbol.dispose]() { db.exec = exec; } };
}

function claimed(db: DatabaseSync, cfg: ReturnType<typeof loadConfig>, run = 'run-1', at = AT) {
  const job = jobs.claim?.(db, cfg, run, at);
  expect(job).toBeTruthy();
  if (!job) throw new Error('Expected an eligible job');
  return job;
}

test('deduplicates a durable job key across two connections and a reopen', () => {
  const files = fixture();
  let id: number;
  {
    using first = openDb(files.path);
    using second = openDb(files.path);
    id = jobs.enqueue(first, 'triage', 'triage:batch:1', { batch: 1, text: 'Durable input' });
    expect(jobs.enqueue(second, 'triage', 'triage:batch:1', { batch: 1 })).toBe(id);
    expect(second.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(1);
    expect(first.isTransaction).toBe(false);
    expect(second.isTransaction).toBe(false);
  }
  using reopened = openDb(files.path);
  const row = reopened.prepare('SELECT * FROM job WHERE id=?').get(id);
  expect(row).toMatchObject({ id, kind: 'triage', key: 'triage:batch:1', state: 'queued', attempts: 0, failures: 0 });
  expect(JSON.parse(String(row?.payload))).toEqual({ batch: 1, text: 'Durable input' });
});

test('claims the oldest eligible row once with a persisted 120-second lease', () => {
  const { path, cfg } = fixture();
  using first = openDb(path);
  using second = openDb(path);
  const oldest = jobs.enqueue(first, 'triage', 'first', {});
  const later = jobs.enqueue(second, 'triage', 'second', {});
  const job = claimed(first, cfg, 'run-1', '2026-11-06T00:00:00.123456Z');
  expect(job).toMatchObject({ id: oldest, state: 'running', run_id: 'run-1', lease_until: '2026-11-06T00:02:00.123456Z', payload: {} });
  expect(job.lease_token).toBeTypeOf('string');
  expect(claimed(second, cfg, 'run-2').id).toBe(later);
  expect(jobs.claim(second, cfg, 'run-3', '2026-11-06T00:01:59.999999Z')).toBeNull();
  expect(first.isTransaction).toBe(false);
  expect(second.isTransaction).toBe(false);
});

test('renews at 30 seconds through the other connection without stealing or resurrecting an expired lease', () => {
  const { path, cfg } = fixture();
  using first = openDb(path);
  using second = openDb(path);
  const id = jobs.enqueue(first, 'triage', 'lease', {});
  const old = claimed(first, cfg);
  expect(jobs.renew?.(second, id, old.lease_token!, '2026-11-06T00:00:30Z')).toBe(true);
  expect(row(first, id).lease_until).toBe('2026-11-06T00:02:30.000000Z');
  expect(jobs.claim(second, cfg, 'other-run', '2026-11-06T00:02:29.999999Z')).toBeNull();
  expect(jobs.renew(second, id, old.lease_token!, '2026-11-06T00:02:30Z')).toBe(false);
  const fresh = claimed(second, cfg, 'other-run', '2026-11-06T00:02:30Z');
  expect(fresh.id).toBe(id);
  expect(fresh.lease_token).not.toBe(old.lease_token);
  expect(jobs.renew(first, id, old.lease_token!, '2026-11-06T00:02:31Z')).toBe(false);
  vi.setSystemTime(new Date('2026-11-06T00:02:31Z'));
  expect(jobs.complete?.(first, old, () => first.exec("INSERT INTO cursor VALUES ('bad','bad','bad')"))).toBe(false);
  expect(first.prepare('SELECT COUNT(*) AS n FROM cursor').get()?.n).toBe(0);
  expect(jobs.complete(second, fresh, () => {})).toBe(true);
});

test('persists configured lease duration for renew instead of using a hidden default', () => {
  const { path, cfg } = fixture({ lease_seconds: 17, renew_seconds: 3 });
  using first = openDb(path);
  using second = openDb(path);
  jobs.enqueue(first, 'triage', 'custom-lease', {});
  const job = claimed(first, cfg);
  expect(job.lease_until).toBe('2026-11-06T00:00:17.000000Z');
  expect(jobs.renew?.(second, job.id, job.lease_token!, '2026-11-06T00:00:03Z')).toBe(true);
  expect(row(first, job.id).lease_until).toBe('2026-11-06T00:00:20.000000Z');
});

test('reopens the unchanged queue after a crash and recovers only expired running work', () => {
  const { path, cfg } = fixture();
  let id: number;
  let unexpired: number;
  {
    using db = openDb(path);
    id = jobs.enqueue(db, 'triage', 'expired', { durable: true });
    claimed(db, cfg, 'before-crash');
    unexpired = jobs.enqueue(db, 'triage', 'still-running', {});
    claimed(db, cfg, 'before-crash', '2026-11-06T00:01:00Z');
  }
  using restarted = openDb(path);
  const job = claimed(restarted, cfg, 'after-crash', '2026-11-06T00:02:00Z');
  expect(job).toMatchObject({ id, run_id: 'after-crash', payload: { durable: true }, attempts: 0, failures: 0 });
  expect(row(restarted, unexpired)).toMatchObject({ state: 'running', run_id: 'before-crash' });
  expect(restarted.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(2);
});

test('rolls back both local effects and completion when a callback throws, then retries the same row after restart', () => {
  const { path, cfg } = fixture();
  let id: number;
  let owner: number;
  {
    using db = openDb(path);
    owner = ticket(db);
    id = jobs.enqueue(db, 'triage', 'atomic', {}, owner);
    const job = claimed(db, cfg);
    expect(() => jobs.complete?.(db, job, () => {
      db.prepare("UPDATE ticket SET summary='must roll back' WHERE id=?").run(owner);
      jobs.enqueue(db, 'collect', 'must-roll-back', {}, owner);
      throw new Error('injected local crash');
    })).toThrow('injected local crash');
    expect(db.prepare('SELECT summary FROM ticket WHERE id=?').get(owner)?.summary).toBe('');
    expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(1);
    expect(row(db, id)).toMatchObject({ state: 'running', lease_token: job.lease_token });
    expect(db.isTransaction).toBe(false);
  }
  using restarted = openDb(path);
  expect(jobs.claim(restarted, cfg, 'restart', '2026-11-06T00:01:59Z')).toBeNull();
  vi.setSystemTime(new Date('2026-11-06T00:02:00Z'));
  const recovered = claimed(restarted, cfg, 'restart', '2026-11-06T00:02:00Z');
  expect(jobs.complete(restarted, recovered, () => {
    restarted.prepare("UPDATE ticket SET summary='committed' WHERE id=?").run(owner);
    jobs.enqueue(restarted, 'collect', 'collector', {}, owner);
  })).toBe(true);
  expect(row(restarted, id)).toMatchObject({ state: 'done', lease_until: null, lease_token: null, run_id: null });
  expect(restarted.prepare('SELECT summary FROM ticket WHERE id=?').get(owner)?.summary).toBe('committed');
  expect(claimed(restarted, cfg, 'collector-run', '2026-11-06T00:02:00Z').kind).toBe('collect');
  expect(jobs.complete(restarted, recovered, () => { throw new Error('must never run twice'); })).toBe(false);
});

test.each(['lease_token', 'run_id', 'state', 'expiry'] as const)('fences effects on current %s', (field) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const id = jobs.enqueue(db, 'triage', 'fenced', {});
  const job = claimed(db, cfg);
  if (field === 'lease_token') job.lease_token = 'forged';
  if (field === 'run_id') job.run_id = 'forged';
  if (field === 'state') db.prepare("UPDATE job SET state='cancelled' WHERE id=?").run(id);
  if (field === 'expiry') vi.setSystemTime(new Date('2026-11-06T00:02:00Z'));
  expect(jobs.complete?.(db, job, () => db.exec("INSERT INTO cursor VALUES ('bad','bad','bad')"))).toBe(false);
  expect(db.prepare('SELECT COUNT(*) AS n FROM cursor').get()?.n).toBe(0);
});

test('rechecks the lease after effects and rolls back if synchronous work crosses expiry', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  jobs.enqueue(db, 'triage', 'cross-expiry', {});
  const job = claimed(db, cfg);
  expect(jobs.complete?.(db, job, () => {
    db.exec("INSERT INTO cursor VALUES ('synthetic','synthetic','synthetic')");
    vi.setSystemTime(new Date('2026-11-06T00:02:00Z'));
  })).toBe(false);
  expect(db.prepare('SELECT COUNT(*) AS n FROM cursor').get()?.n).toBe(0);
  expect(row(db, job.id).state).toBe('running');
});

test('rejects asynchronous completion effects without committing their synchronous writes', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  jobs.enqueue(db, 'triage', 'sync-only', {});
  const job = claimed(db, cfg);
  expect(() => jobs.complete?.(db, job, () => {
    db.exec("INSERT INTO cursor VALUES ('synthetic','synthetic','synthetic')");
    return Promise.resolve();
  })).toThrow(/synchronous/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM cursor').get()?.n).toBe(0);
  expect(row(db, job.id).state).toBe('running');
});

test('defer keeps durable payload, updates only an owned lease and never auto-completes polling', () => {
  const { path, cfg } = fixture();
  using first = openDb(path);
  using second = openDb(path);
  const id = jobs.enqueue(first, 'collect', 'collect:turn:1', { turn: 1, pending: [2, 3] });
  const old = claimed(first, cfg);
  expect(jobs.defer?.(first, old, '2026-11-06T00:00:10+00:00')).toBe(true);
  expect(row(second, id)).toMatchObject({ state: 'queued', lease_token: null, run_id: null, lease_until: null,
    next_at: '2026-11-06T00:00:10.000000Z', attempts: 0, failures: 0 });
  expect(JSON.parse(String(row(second, id).payload))).toEqual({ turn: 1, pending: [2, 3] });
  expect(jobs.claim(second, cfg, 'poll', '2026-11-06T00:00:09Z')).toBeNull();
  const fresh = claimed(second, cfg, 'poll', '2026-11-06T00:00:10Z');
  vi.setSystemTime(new Date('2026-11-06T00:00:10Z'));
  expect(jobs.defer(first, old, '2026-11-06T01:00:00Z', { overwritten: true })).toBe(false);
  expect(jobs.defer(second, fresh, '2026-11-06T00:00:20Z', { turn: 1, pending: [2, 3, 4] })).toBe(true);
  expect(JSON.parse(String(row(first, id).payload))).toEqual({ turn: 1, pending: [2, 3, 4] });
});

test('literal ticket FIFO blocks behind a backoff head across linked conversations but not independent tickets', () => {
  const { path, cfg } = fixture();
  using first = openDb(path);
  using second = openDb(path);
  const owner = ticket(first);
  const other = ticket(first, 'Independent');
  first.exec("INSERT INTO conversation(id,source,account,native_id) VALUES (1,'teams','synthetic','one'),(2,'outlook','synthetic','two')");
  const link = first.prepare('INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,?,?,?,?)');
  link.run(owner, 1, 'primary', 'rule', AT);
  link.run(owner, 2, 'linked', 'rule', AT);
  const head = jobs.enqueue(first, 'triage', 'head', { conversation: 1 }, owner);
  const tail = jobs.enqueue(first, 'forward', 'tail', { conversation: 2, batch_ids: [2] }, owner);
  const independent = jobs.enqueue(first, 'triage', 'independent', {}, other);
  first.prepare('UPDATE job SET next_at=? WHERE id=?').run('2026-11-06T01:00:00.000000Z', head);
  const free = claimed(second, cfg);
  expect(free.id).toBe(independent);
  expect(jobs.complete(second, free, () => {})).toBe(true);
  expect(jobs.claim(second, cfg, 'no-overtaking')).toBeNull();
  expect(jobs.park?.(first, head, 'manual inspection')).toBeUndefined();
  expect(row(first, head).state).toBe('parked');
  expect(jobs.claim(second, cfg, 'parked-barrier', '2026-11-06T02:00:00Z')).toBeNull();
  jobs.retry?.(first, head);
  const retried = claimed(second, cfg, 'retry');
  expect(retried.id).toBe(head);
  expect(jobs.claim(first, cfg, 'running-barrier')).toBeNull();
  expect(jobs.complete(second, retried, () => {})).toBe(true);
  expect(claimed(first, cfg, 'tail').id).toBe(tail);
});

test('done and cancelled heads release ticket FIFO while manual retry resets both counters and errors', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const owner = ticket(db);
  const head = jobs.enqueue(db, 'triage', 'cancelled', {}, owner);
  const next = jobs.enqueue(db, 'triage', 'after-cancel', {}, owner);
  db.prepare("UPDATE job SET state='cancelled' WHERE id=?").run(head);
  const job = claimed(db, cfg);
  expect(job.id).toBe(next);
  jobs.park?.(db, next, 'deterministic failure');
  db.prepare("UPDATE job SET attempts=4,failures=9,error_class='unknown' WHERE id=?").run(next);
  jobs.retry?.(db, next);
  expect(row(db, next)).toMatchObject({ state: 'queued', attempts: 0, failures: 0, error_class: null, last_error: null,
    lease_until: null, lease_token: null, run_id: null, next_at: AT });
});

test.each([
  ['HTTP 408', { status: 408 }, 'dependency'],
  ['HTTP 429', { status: 429 }, 'dependency'],
  ['HTTP 500', { statusCode: 500 }, 'dependency'],
  ['HTTP 503', { response: { status: 503 } }, 'dependency'],
  ['HTTP 529', { status_code: 529 }, 'dependency'],
  ['HTTP 599', { status: 599 }, 'dependency'],
  ['refused', { code: 'ECONNREFUSED' }, 'dependency'],
  ['reset', { code: 'ECONNRESET' }, 'dependency'],
  ['timeout', { code: 'ETIMEDOUT' }, 'dependency'],
  ['fetch timeout', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, 'dependency'],
  ['TimeoutError', new DOMException('Timed out', 'TimeoutError'), 'dependency'],
  ['COM RPC hex', { hresult: '0x800706BA' }, 'dependency'],
  ['COM retry-later hex', { code: '0x80010001' }, 'dependency'],
  ['COM RPC unsigned', { hresult: 0x800706BA }, 'dependency'],
  ['COM RPC signed', { hresult: -2147023174 }, 'dependency'],
  ['COM rejected signed', { hresult: -2147418111 }, 'dependency'],
  ['SQLite busy number', { errcode: 5 }, 'dependency'],
  ['SQLite locked number', { errcode: 6 }, 'dependency'],
  ['SQLite extended busy', { errcode: 517 }, 'dependency'],
  ['SQLite code', { code: 'SQLITE_BUSY' }, 'dependency'],
  ['SQLite extended code', { code: 'SQLITE_LOCKED_SHAREDCACHE' }, 'dependency'],
  ['provider transport cause', { type: 'provider.transport', cause: { code: 'ECONNREFUSED' } }, 'dependency'],
  ['nested provider data', { error: { type: 'provider.transport', data: { cause: { code: 'ECONNRESET' } } } }, 'dependency'],
  ['generic structured transport', { type: 'provider.transport' }, 'dependency'],
  ['HTTP 400', { status: 400 }, 'job'],
  ['HTTP 403', { status: 403 }, 'job'],
  ['401 after sign-in', { status: 401, fresh_sign_in: true }, 'job'],
  ['401 after nested sign-in', { response: { status: 401 }, auth_refreshed: true }, 'job'],
  ['session 404', { status: 404, resource: 'session' }, 'job'],
  ['typed session 404', { type: 'session.not-found', status: 404 }, 'job'],
  ['invalid repaired decision', { type: 'model.invalid-decision', repaired: true }, 'job'],
  ['provider configuration', { type: 'provider.no-route' }, 'job'],
  ['provider config overrides transport cause', { type: 'provider.no-route', cause: { code: 'ECONNREFUSED' } }, 'job'],
  ['TypeError', new TypeError('Programming fault'), 'job'],
  ['ReferenceError', new ReferenceError('Missing variable'), 'job'],
  ['SyntaxError', new SyntaxError('Programming fault'), 'job'],
  ['RangeError', new RangeError('Programming fault'), 'job'],
  ['unrefreshed 401', { status: 401 }, 'unknown'],
  ['ordinary 404', { status: 404, resource: 'other' }, 'unknown'],
  ['first invalid decision', { type: 'model.invalid-decision', repaired: false }, 'unknown'],
  ['ordinary Error', new Error('Unclassified failure'), 'unknown'],
  ['quota words alone', new Error('quota rate limit 429 exceeded'), 'unknown'],
  ['status words alone', 'HTTP 503 unavailable', 'unknown'],
  ['undefined', undefined, 'unknown'],
  ['null', null, 'unknown'],
])('classifies %s from structured fields', (_name, error, expected) => {
  expect(jobs.classify?.(error)).toMatchObject({ error_class: expected });
});

test('classifies an actual two-connection SQLite busy exception without message heuristics', () => {
  const { path } = fixture();
  using first = openDb(path);
  using second = openDb(path);
  second.exec('PRAGMA busy_timeout=0');
  first.exec('BEGIN IMMEDIATE');
  try {
    let observed: unknown;
    try {
      second.exec("INSERT INTO cursor VALUES ('synthetic','synthetic','synthetic')");
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(Error);
    expect(jobs.classify?.(observed)).toMatchObject({ error_class: 'dependency' });
  } finally {
    first.exec('ROLLBACK');
  }
});

test('extracts structured Retry-After and handles circular causes', () => {
  const error: Record<string, unknown> = { type: 'provider.transport', response: { status: 429, headers: new Headers({ 'Retry-After': '7200' }) } };
  error.cause = error;
  expect(jobs.classify?.(error)).toMatchObject({ error_class: 'dependency', retry_after: '7200' });
  expect(jobs.classify?.({ status: 503, retry_after: 90 })).toMatchObject({ retry_after: 90 });
  expect(jobs.classify?.({ response: { status: 429, headers: { 'retry-after': '120' } } })).toMatchObject({ retry_after: '120' });
});

test.each([
  [1, 0, null, 8], [1, 1, null, 12], [1, 0.5, null, 10], [2, 0.5, null, 20],
  [0, 0.5, null, 10], [30, 1, null, 1800], [1000, 0, null, 1440],
  [1, 0, 60, 60], [1, 1, 3600, 3600], [100, 1, '7200', 7200],
  [1, 0.5, 'Fri, 06 Nov 2026 02:00:00 GMT', 7200],
  [1, 0.5, 'Thu, 05 Nov 2026 23:00:00 GMT', 10],
  [1, 0.5, -1, 10], [1, 0.5, 'invalid-header', 10],
])('backoff returns seconds with failure=%s random=%s Retry-After=%s', (count, random, retryAfter, expected) => {
  const { cfg } = fixture();
  expect(jobs.backoff?.(count, cfg.jobs, retryAfter, random, AT)).toBeCloseTo(expected);
});

test.each([
  { backoff_initial_seconds: 0 }, { backoff_initial_seconds: 1801 },
  { backoff_max_seconds: -1 }, { backoff_jitter: -0.1 }, { backoff_jitter: 1.1 }, { backoff_jitter: NaN },
])('validates explicit backoff policy %j', (policy) => {
  const { cfg } = fixture(policy);
  expect(() => jobs.backoff?.(1, cfg.jobs, null, 0.5)).toThrow(/policy/);
});

test.each([-1, 1.1, NaN, Infinity])('rejects invalid jitter random value %s', (random) => {
  const { cfg } = fixture();
  expect(() => jobs.backoff?.(1, cfg.jobs, null, random)).toThrow(/random/);
});

test.each([-1, 1.5, NaN, Infinity])('rejects invalid failure counter %s', (count) => {
  const { cfg } = fixture();
  expect(() => jobs.backoff?.(count, cfg.jobs, null, 0.5)).toThrow(/failures/);
});

test('uses configured backoff and Retry-After without mixing seconds and milliseconds', () => {
  const { path, cfg } = fixture({ backoff_initial_seconds: 7, backoff_max_seconds: 13, backoff_jitter: 0 });
  using db = openDb(path);
  jobs.enqueue(db, 'triage', 'custom-backoff', {});
  const job = claimed(db, cfg);
  expect(jobs.backoff?.(1, cfg.jobs, undefined, 0.5, AT)).toBe(7);
  expect(jobs.backoff?.(2, cfg.jobs, undefined, 0.5, AT)).toBe(13);
  expect(jobs.fail?.(db, cfg, job, { status: 429, retry_after: '60' }, { at: AT, randomValue: 0.5, dependency: 'synthetic-upstream' })).toBe(true);
  expect(row(db, job.id).next_at).toBe('2026-11-06T00:01:00.000000Z');
});

test('one hundred consecutive dependency retries never consume attempts or park', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const id = jobs.enqueue(db, 'triage', 'long-outage', { durable: true });
  for (let n = 1; n <= 100; n++) {
    const at = String(row(db, id).next_at);
    vi.setSystemTime(new Date(at));
    const job = claimed(db, cfg, `run-${n}`, at);
    expect(jobs.fail?.(db, cfg, job, { type: 'provider.transport', cause: { code: 'ECONNREFUSED' } },
      { dependency: 'synthetic-upstream', at, randomValue: 0.5 })).toBe(true);
    expect(row(db, id)).toMatchObject({ state: 'queued', attempts: 0, failures: n, error_class: 'dependency', lease_token: null, run_id: null });
  }
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(1);
  expect(db.prepare("SELECT state,since FROM health WHERE dependency='synthetic-upstream'").get())
    .toMatchObject({ state: 'failing', since: AT });
});

test('unknown errors park on the fifth attempt and manual retry releases the same FIFO head', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const owner = ticket(db);
  const id = jobs.enqueue(db, 'triage', 'unknown-head', {}, owner);
  jobs.enqueue(db, 'forward', 'blocked-tail', { batch_ids: [2] }, owner);
  for (let n = 1; n <= 5; n++) {
    const at = String(row(db, id).next_at);
    vi.setSystemTime(new Date(at));
    const job = claimed(db, cfg, `run-${n}`, at);
    expect(job.id).toBe(id);
    expect(jobs.fail?.(db, cfg, job, new Error('unclassified'), { at, randomValue: 0.5 })).toBe(true);
    expect(row(db, id)).toMatchObject({ state: n === 5 ? 'parked' : 'queued', attempts: n, failures: n, error_class: 'unknown' });
  }
  expect(jobs.claim(db, cfg, 'blocked', '2026-11-06T12:00:00Z')).toBeNull();
  jobs.retry(db, id);
  expect(row(db, id)).toMatchObject({ state: 'queued', attempts: 0, failures: 0, error_class: null, last_error: null });
  expect(claimed(db, cfg, 'manual-retry', String(row(db, id).next_at)).id).toBe(id);
});

test('job errors park immediately and configured unknown attempt limit is honored', () => {
  const { path, cfg } = fixture({ max_attempts: 1 });
  using db = openDb(path);
  const first = jobs.enqueue(db, 'triage', 'invalid', {});
  const firstJob = claimed(db, cfg);
  expect(jobs.fail?.(db, cfg, firstJob, { status: 400 }, { at: AT, randomValue: 0.5 })).toBe(true);
  expect(row(db, first)).toMatchObject({ state: 'parked', attempts: 1, failures: 1, error_class: 'job' });
  const second = jobs.enqueue(db, 'triage', 'unknown', {});
  const secondJob = claimed(db, cfg);
  expect(jobs.fail?.(db, cfg, secondJob, new Error('unknown'), { at: AT, randomValue: 0.5 })).toBe(true);
  expect(row(db, second)).toMatchObject({ state: 'parked', attempts: 1, failures: 1, error_class: 'unknown' });
});

test('a stale failure cannot change another claim or its health', () => {
  const { path, cfg } = fixture();
  using first = openDb(path);
  using second = openDb(path);
  const id = jobs.enqueue(first, 'triage', 'stale-fail', {});
  const old = claimed(first, cfg);
  const fresh = claimed(second, cfg, 'fresh-run', '2026-11-06T00:02:00Z');
  expect(jobs.fail?.(first, cfg, old, new TypeError('stale'), { at: '2026-11-06T00:02:01Z', dependency: 'must-not-change' })).toBe(false);
  expect(row(second, id)).toMatchObject({ state: 'running', attempts: 0, failures: 0, lease_token: fresh.lease_token });
  expect(second.prepare('SELECT COUNT(*) AS n FROM health').get()?.n).toBe(0);
});

test('persists first dependency error immediately, fails at three and keeps original since through restart', () => {
  const { path, cfg } = fixture();
  {
    using db = openDb(path);
    jobs.healthError?.(db, cfg, 'openchamber', new Error('first'), AT);
    expect(db.prepare("SELECT * FROM health WHERE dependency='openchamber'").get())
      .toMatchObject({ state: 'retrying', since: AT, last_error: 'first' });
  }
  using db = openDb(path);
  jobs.healthError(db, cfg, 'openchamber', new Error('second'), '2026-11-06T00:00:10Z');
  expect(db.prepare("SELECT * FROM health WHERE dependency='openchamber'").get()).toMatchObject({ state: 'retrying', since: AT });
  jobs.healthError(db, cfg, 'openchamber', new Error('third'), '2026-11-06T00:00:20Z');
  expect(db.prepare("SELECT * FROM health WHERE dependency='openchamber'").get()).toMatchObject({ state: 'failing', since: AT });
  expect(JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='openchamber'").get()?.detail)))
    .toMatchObject({ consecutive_errors: 3 });
});

test('source failures are immediately failing and success preserves unrelated durable detail', () => {
  const { path, cfg } = fixture();
  using first = openDb(path);
  using second = openDb(path);
  prepareStart(first, undefined, AT);
  const initial = JSON.parse(String(first.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()?.detail));
  initial.run_id = 'durable-run';
  initial.pid = 123;
  first.prepare("UPDATE health SET detail=? WHERE dependency='daemon'").run(JSON.stringify(initial));
  jobs.healthError?.(second, cfg, 'daemon', new Error('one'), AT);
  expect(first.prepare("SELECT state FROM health WHERE dependency='daemon'").get()?.state).toBe('retrying');
  jobs.healthError(first, cfg, 'outlook', new Error('source unavailable'), AT, true);
  expect(second.prepare("SELECT state,since FROM health WHERE dependency='outlook'").get()).toMatchObject({ state: 'failing', since: AT });
  jobs.healthOk?.(second, 'daemon', '2026-11-06T00:00:30Z', { pid: 456 });
  const healthy = first.prepare("SELECT * FROM health WHERE dependency='daemon'").get()!;
  expect(healthy).toMatchObject({ state: 'ok', last_error: null, last_ok: '2026-11-06T00:00:30.000000Z' });
  expect(JSON.parse(String(healthy.detail))).toEqual({ ...initial, pid: 456, consecutive_errors: 0 });
  jobs.healthError(first, cfg, 'daemon', new Error('new streak'), '2026-11-06T00:01:00Z');
  expect(second.prepare("SELECT state,since,last_ok FROM health WHERE dependency='daemon'").get())
    .toMatchObject({ state: 'retrying', since: '2026-11-06T00:01:00.000000Z', last_ok: '2026-11-06T00:00:30.000000Z' });
});

test('health threshold is explicit configured policy rather than a second fixed policy', () => {
  const { path, cfg } = fixture({ dependency_failure_threshold: 1 });
  using db = openDb(path);
  jobs.healthError?.(db, cfg, 'custom-threshold', new Error('one'), AT);
  expect(db.prepare("SELECT state FROM health WHERE dependency='custom-threshold'").get()?.state).toBe('failing');
});

test.each(['sync', 'archive', 'purge'] as const)('maintenance %s never parks for job or unknown failures and always updates health', (kind) => {
  const { path, cfg } = fixture({ max_attempts: 1 });
  using db = openDb(path);
  const id = jobs.enqueue(db, kind, `maintenance:${kind}`, {});
  for (let n = 1; n <= 6; n++) {
    const at = String(row(db, id).next_at);
    vi.setSystemTime(new Date(at));
    const job = claimed(db, cfg, `run-${n}`, at);
    expect(jobs.fail?.(db, cfg, job, n % 2 ? new TypeError('maintenance job failure') : new Error('unknown maintenance failure'),
      { at, randomValue: 0.5 })).toBe(true);
    expect(row(db, id)).toMatchObject({ state: 'queued', failures: n });
  }
  expect(db.prepare('SELECT state,since FROM health').get()).toMatchObject({ state: 'failing', since: AT });
  expect(() => jobs.park(db, id, 'manual')).toThrow(/maintenance/);
});

test('enforces the global three-triage cap across connections without limiting collect or sync polling', () => {
  const { path, cfg } = fixture();
  using first = openDb(path);
  using second = openDb(path);
  const ids = Array.from({ length: 5 }, (_, n) => jobs.enqueue(first, 'triage', `triage:${n}`, {}));
  expect([claimed(first, cfg).id, claimed(second, cfg).id, claimed(first, cfg).id]).toEqual(ids.slice(0, 3));
  expect(jobs.claim(second, cfg, 'over-cap')).toBeNull();
  const polls = Array.from({ length: 12 }, (_, n) => jobs.enqueue(first, n % 2 ? 'collect' : 'sync', `poll:${n}`, {}));
  for (const id of polls) expect(claimed(second, cfg, `poll:${id}`).id).toBe(id);
  expect(jobs.claim(first, cfg, 'over-cap')).toBeNull();
  expect(first.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='triage' AND state='running'").get()?.n).toBe(3);
});

test('reserves four input slots at claim before any POST and retains them through defer, failure, parking and restart', () => {
  const { path, cfg } = fixture();
  let ids: number[];
  {
    using first = openDb(path);
    using second = openDb(path);
    ids = Array.from({ length: 5 }, (_, n) => jobs.enqueue(first, n % 2 ? 'forward' : 'start_chat', `input:${n}`, { batch_ids: [n + 1] }, ticket(first)));
    const running = [claimed(first, cfg), claimed(second, cfg), claimed(first, cfg), claimed(second, cfg)];
    expect(running.map((job) => job.id)).toEqual(ids.slice(0, 4));
    expect(running.every((job) => job.reserved_at === AT)).toBe(true);
    expect(jobs.claim(second, cfg, 'fifth')).toBeNull();
    expect(jobs.fail(first, cfg, running[0]!, { status: 503 }, { at: AT, randomValue: 0.5 })).toBe(true);
    expect(jobs.defer(second, running[1]!, '2026-11-06T01:00:00Z')).toBe(true);
    jobs.park(first, running[2]!.id, 'uncertain input needs reconciliation');
    expect(first.prepare('SELECT COUNT(*) AS n FROM job WHERE reserved_at IS NOT NULL').get()?.n).toBe(4);
  }
  using restarted = openDb(path);
  expect(jobs.claim(restarted, cfg, 'still-full', '2026-11-06T00:00:01Z')).toBeNull();
  const reconcile = claimed(restarted, cfg, 'reconcile-existing-slot', '2026-11-06T00:00:10Z');
  expect(reconcile.id).toBe(ids[0]);
  expect(reconcile.reserved_at).toBe(AT);
  expect(jobs.claim(restarted, cfg, 'still-full', '2026-11-06T00:00:11Z')).toBeNull();
  expect(row(restarted, ids[4]!).state).toBe('queued');
});

test('one reservation transfers to a prepared turn without double-counting and survives successful job completion', () => {
  const { path, cfg } = fixture({ turn_concurrency: 1 });
  using first = openDb(path);
  using second = openDb(path);
  const owner = ticket(first);
  const id = jobs.enqueue(first, 'forward', 'first-input', { batch_ids: [1] }, owner);
  const next = jobs.enqueue(first, 'start_chat', 'next-input', {}, ticket(first));
  const job = claimed(first, cfg);
  const prepared = turn(first, owner, 'immutable-prompt');
  expect(jobs.reserveTurn?.(second, cfg, job, prepared, AT)).toBe(true);
  expect(jobs.reserveTurn(second, cfg, job, prepared, AT)).toBe(true);
  expect(row(first, id)).toMatchObject({ turn_id: prepared, reserved_at: AT });
  expect(first.prepare('SELECT reserved_at FROM turn WHERE id=?').get(prepared)?.reserved_at).toBe(AT);
  expect(jobs.claim(second, cfg, 'over-cap')).toBeNull();
  expect(jobs.complete(first, job, () => {})).toBe(true);
  for (const state of ['prepared', 'admitted', 'running']) {
    first.prepare('UPDATE turn SET state=? WHERE id=?').run(state, prepared);
    expect(jobs.claim(second, cfg, 'over-cap')).toBeNull();
  }
  first.prepare("UPDATE turn SET state='done',outcome='succeeded',completed_at=? WHERE id=?").run(AT, prepared);
  expect(claimed(second, cfg, 'released').id).toBe(next);
});

test('counts admitted turns even without a local running job and treats reserved reconciliation as zero new slots', () => {
  const { path, cfg } = fixture({ turn_concurrency: 2 });
  using first = openDb(path);
  using second = openDb(path);
  const owner = ticket(first);
  const jobId = jobs.enqueue(first, 'forward', 'reserved-reconciliation', { batch_ids: [1] }, owner);
  const original = claimed(first, cfg);
  const ownTurn = turn(first, owner, 'own-prepared');
  expect(jobs.reserveTurn?.(first, cfg, original, ownTurn, AT)).toBe(true);
  expect(jobs.fail(first, cfg, original, { code: 'ECONNRESET' }, { at: AT, randomValue: 0.5 })).toBe(true);
  const other = ticket(first);
  turn(first, other, 'remote-admitted', 'admitted');
  const later = jobs.enqueue(first, 'start_chat', 'new-input', {}, ticket(first));
  expect(jobs.claim(second, cfg, 'full', '2026-11-06T00:00:01Z')).toBeNull();
  const reconcile = claimed(second, cfg, 'reconcile', '2026-11-06T00:00:10Z');
  expect(reconcile.id).toBe(jobId);
  expect(jobs.reserveTurn(first, cfg, reconcile, ownTurn, '2026-11-06T00:00:10Z')).toBe(true);
  expect(jobs.claim(first, cfg, 'no-new-slot', '2026-11-06T00:00:10Z')).toBeNull();
  expect(row(first, later).state).toBe('queued');
});

test('reservation primitive fences ownership, validates ticket/turn binding and caps recovery reservations too', () => {
  const { path, cfg } = fixture({ turn_concurrency: 1 });
  using first = openDb(path);
  using second = openDb(path);
  const owner = ticket(first);
  const input = jobs.enqueue(first, 'forward', 'binding', { batch_ids: [1] }, owner);
  const old = claimed(first, cfg);
  const ownTurn = turn(first, owner, 'bound-prompt');
  const wrongTurn = turn(first, ticket(first), 'wrong-ticket');
  expect(() => jobs.reserveTurn?.(first, cfg, old, wrongTurn, AT)).toThrow(/ticket/);
  expect(jobs.reserveTurn(first, cfg, old, ownTurn, AT)).toBe(true);
  const replacement = turn(first, owner, 'cannot-replace');
  expect(() => jobs.reserveTurn(first, cfg, old, replacement, AT)).toThrow(/bound/);
  const fresh = claimed(second, cfg, 'fresh', '2026-11-06T00:02:00Z');
  expect(fresh.id).toBe(input);
  expect(jobs.reserveTurn(first, cfg, old, ownTurn, '2026-11-06T00:02:00Z')).toBe(false);
  jobs.enqueue(second, 'collect', 'recovery-owner', {}, ticket(second));
  const recovery = claimed(second, cfg, 'recovery', '2026-11-06T00:02:00Z');
  const recoveryTurn = turn(second, recovery.ticket!, 'recovery-prompt');
  expect(jobs.reserveTurn(first, cfg, recovery, recoveryTurn, '2026-11-06T00:02:00Z')).toBe(false);
  expect(second.prepare('SELECT reserved_at FROM turn WHERE id=?').get(recoveryTurn)?.reserved_at).toBeNull();
});

test('custom triage and turn caps come from the same jobs policy', () => {
  const { path, cfg } = fixture({ triage_concurrency: 1, turn_concurrency: 1 });
  using db = openDb(path);
  jobs.enqueue(db, 'triage', 'triage:1', {});
  jobs.enqueue(db, 'triage', 'triage:2', {});
  jobs.enqueue(db, 'start_chat', 'input:1', {}, ticket(db));
  jobs.enqueue(db, 'start_chat', 'input:2', {}, ticket(db));
  expect(claimed(db, cfg).kind).toBe('triage');
  expect(claimed(db, cfg).kind).toBe('start_chat');
  expect(jobs.claim(db, cfg, 'full')).toBeNull();
});

test('two truly concurrent SQLite connections can claim a row only once', async () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const id = jobs.enqueue(db, 'triage', 'racing-key', {});
  const results = await raceClaims(cfg, AT, 2);
  expect(results.filter((value) => value === id)).toHaveLength(1);
  expect(results.filter((value) => value === null)).toHaveLength(1);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE state='running'").get()?.n).toBe(1);
});

test('racing connections cannot exceed the configured global input cap', async () => {
  const { path, cfg } = fixture({ turn_concurrency: 2 });
  using db = openDb(path);
  for (let n = 0; n < 6; n++) jobs.enqueue(db, 'start_chat', `racing-input:${n}`, {}, ticket(db));
  const results = await raceClaims(cfg, AT, 6);
  expect(results.filter((value) => value !== null)).toHaveLength(2);
  expect(new Set(results.filter((value) => value !== null)).size).toBe(2);
  expect(db.prepare('SELECT COUNT(*) AS n FROM job WHERE reserved_at IS NOT NULL').get()?.n).toBe(2);
});

test('renewal owns a separate short connection while a request awaits and stops explicitly', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(AT));
  const { path, cfg } = fixture();
  using first = openDb(path);
  using second = openDb(path);
  second.exec('PRAGMA busy_timeout=0');
  const id = jobs.enqueue(first, 'triage', 'awaiting', {});
  const job = claimed(first, cfg);
  const request = Promise.withResolvers<string>();
  const pending = request.promise.then((value) => {
    expect(value).toBe('observed response');
    return jobs.complete(first, job, () => {});
  });
  const renewal = jobs.startRenewal?.(cfg, job);
  expect(renewal).toBeTruthy();
  if (!renewal) return;
  try {
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(row(second, id).lease_until).toBe('2026-11-06T00:02:30.000000Z');
    second.exec("INSERT INTO cursor VALUES ('synthetic','during-await','synthetic')");
    expect(jobs.claim(second, cfg, 'cannot-steal', '2026-11-06T00:02:29Z')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(row(first, id).lease_until).toBe('2026-11-06T00:03:00.000000Z');
    expect(first.isTransaction).toBe(false);
    expect(second.isTransaction).toBe(false);
    request.resolve('observed response');
    expect(await pending).toBe(true);
  } finally {
    renewal.stop();
    renewal.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});

test('renewal stops on lost ownership and disposable cleanup leaves no timers', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(AT));
  const { path, cfg } = fixture({ renew_seconds: 7 });
  using db = openDb(path);
  jobs.enqueue(db, 'triage', 'lost-renewal', {});
  const job = claimed(db, cfg);
  const errors: unknown[] = [];
  const renewal = jobs.startRenewal?.(cfg, job, (error) => errors.push(error));
  expect(renewal).toBeTruthy();
  if (!renewal) return;
  try {
    jobs.park(db, job.id, 'ownership revoked');
    await vi.advanceTimersByTimeAsync(6999);
    expect(errors).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(renewal.lost).toBe(true);
    expect(errors).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    renewal[Symbol.dispose]();
  }
});

test('adds only nullable job refinements to a Phase 1 v2 scratch DB without losing its queue', () => {
  const { path } = fixture();
  let id: number;
  {
    using db = openDb(path);
    id = jobs.enqueue(db, 'triage', 'retained-v2', { original: true });
    db.exec('DROP INDEX IF EXISTS job_turn');
    const columns = db.prepare('PRAGMA table_info(job)').all().map((column) => column.name);
    for (const column of ['lease_seconds', 'reserved_at', 'turn_id', 'merged_into']) {
      if (columns.includes(column)) db.exec(`ALTER TABLE job DROP COLUMN ${column}`);
    }
  }
  using refined = openDb(path);
  expect(refined.prepare('PRAGMA table_info(job)').all().map((column) => column.name))
    .toEqual(expect.arrayContaining(['lease_seconds', 'reserved_at', 'turn_id', 'merged_into']));
  expect(row(refined, id)).toMatchObject({ state: 'queued', payload: '{"original":true}' });
  expect(refined.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  expect(refined.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('parked forward absorbs unique unsent batch ids in stable order and persists duplicate-key aliases', () => {
  const { path, cfg } = fixture();
  let head: number;
  let owner: number;
  {
    using first = openDb(path);
    using second = openDb(path);
    owner = ticket(first);
    head = jobs.enqueue(first, 'forward', 'forward:head', { batch_ids: [1, 1], context: 'keep' }, owner);
    jobs.park(first, head, 'upstream requires repair');
    expect(jobs.enqueue(second, 'forward', 'forward:tail', { batch_ids: [2, 3, 2] }, owner)).toBe(head);
    expect(jobs.enqueue(first, 'forward', 'forward:tail', { batch_ids: [3, 4] }, owner)).toBe(head);
    expect(jobs.enqueue(second, 'forward', 'forward:tail', { batch_ids: [4, 5] }, owner)).toBe(head);
    expect(JSON.parse(String(row(first, head).payload))).toEqual({ batch_ids: [1, 2, 3, 4, 5], context: 'keep' });
    expect(second.prepare("SELECT state,merged_into FROM job WHERE key='forward:tail'").get())
      .toMatchObject({ state: 'cancelled', merged_into: head });
    expect(second.prepare("SELECT COUNT(*) AS n FROM job WHERE state='parked'").get()?.n).toBe(1);
  }
  using reopened = openDb(path);
  expect(JSON.parse(String(row(reopened, head).payload))).toMatchObject({ batch_ids: [1, 2, 3, 4, 5] });
  jobs.retry(reopened, head);
  const job = claimed(reopened, cfg);
  expect(job.payload.batch_ids).toEqual([1, 2, 3, 4, 5]);
  expect(jobs.complete(reopened, job, () => {})).toBe(true);
  expect(jobs.enqueue(reopened, 'forward', 'forward:tail', { batch_ids: [2, 3] }, owner)).toBe(head);
  expect(reopened.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(2);
  expect(jobs.claim(reopened, cfg, 'no-duplicate')).toBeNull();
});

test('parked input with an uncertain prepared turn keeps immutable input separate from its durable pending tail', () => {
  const { path, cfg } = fixture({ turn_concurrency: 1 });
  let head: number;
  let prepared: number;
  let owner: number;
  {
    using first = openDb(path);
    using second = openDb(path);
    owner = ticket(first);
    head = jobs.enqueue(first, 'forward', 'uncertain-head', { batch_ids: [1], text: 'Original payload', prompt_id: 'immutable-prompt', session_id: 'original-target' }, owner);
    const job = claimed(first, cfg);
    prepared = turn(first, owner, 'immutable-prompt');
    expect(jobs.reserveTurn(first, cfg, job, prepared, AT)).toBe(true);
    expect(jobs.fail(first, cfg, job, new TypeError('cannot prove acceptance'), { at: AT })).toBe(true);
    expect(jobs.enqueue(second, 'forward', 'unsent-tail', { batch_ids: [2, 3], text: 'Different text', session_id: 'different-target' }, owner)).toBe(head);
    expect(jobs.enqueue(first, 'forward', 'uncertain-head', { batch_ids: [1, 3, 4], prompt_id: 'must-not-rewrite' }, owner)).toBe(head);
    expect(JSON.parse(String(row(first, head).payload))).toEqual({ batch_ids: [1], pending_batch_ids: [2, 3, 4],
      text: 'Original payload', prompt_id: 'immutable-prompt', session_id: 'original-target' });
    expect(first.prepare('SELECT prompt_id,text,session_id,state FROM turn WHERE id=?').get(prepared))
      .toMatchObject({ prompt_id: 'immutable-prompt', text: 'Immutable source input', session_id: 'synthetic-session', state: 'prepared' });
  }
  using reopened = openDb(path);
  jobs.retry(reopened, head);
  const reconcile = claimed(reopened, cfg);
  expect(reconcile).toMatchObject({ id: head, turn_id: prepared, payload: { batch_ids: [1], pending_batch_ids: [2, 3, 4] } });
  expect(jobs.complete(reopened, reconcile, () => {
    jobs.enqueue(reopened, 'collect', 'collect:uncertain', { turn_id: prepared }, owner);
  })).toBe(true);
  expect(claimed(reopened, cfg, 'reconcile-before-tail').kind).toBe('collect');
  expect(reopened.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='forward' AND state IN ('queued','running')").get()?.n).toBe(0);
  expect(JSON.parse(String(row(reopened, head).payload)).pending_batch_ids).toEqual([2, 3, 4]);
});

test('concurrent duplicate enqueues lose no parked-forward tail updates', async () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const owner = ticket(db);
  const head = jobs.enqueue(db, 'forward', 'merge-head', { batch_ids: [1] }, owner);
  jobs.park(db, head, 'parked');
  const ids = await raceEnqueues(cfg, AT, [
    { key: 'same-later-key', ticket: owner, batch_ids: [2, 3] },
    { key: 'same-later-key', ticket: owner, batch_ids: [3, 4] },
  ]);
  expect(ids).toEqual([head, head]);
  const payload = JSON.parse(String(row(db, head).payload));
  expect(payload.batch_ids[0]).toBe(1);
  expect(new Set(payload.batch_ids)).toEqual(new Set([1, 2, 3, 4]));
  expect(payload.batch_ids).toHaveLength(4);
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(2);
});

test('parked-tail merge and alias creation roll back with a failed completion transaction', () => {
  const { path, cfg } = fixture();
  using first = openDb(path);
  using second = openDb(path);
  const owner = ticket(first);
  const head = jobs.enqueue(first, 'forward', 'merge-rollback-head', { batch_ids: [1] }, owner);
  jobs.park(first, head, 'parked');
  jobs.enqueue(first, 'triage', 'independent-local-effects', {});
  const job = claimed(first, cfg);
  expect(() => jobs.complete(first, job, () => {
    expect(jobs.enqueue(first, 'forward', 'merge-rollback-alias', { batch_ids: [2] }, owner)).toBe(head);
    expect(JSON.parse(String(row(second, head).payload))).toEqual({ batch_ids: [1] });
    throw new Error('crash after merge');
  })).toThrow('crash after merge');
  expect(JSON.parse(String(row(second, head).payload))).toEqual({ batch_ids: [1] });
  expect(second.prepare("SELECT id FROM job WHERE key='merge-rollback-alias'").get()).toBeUndefined();
  expect(row(second, job.id).state).toBe('running');
});

test('a job key cannot silently bind to another kind or ticket', () => {
  const { path } = fixture();
  using db = openDb(path);
  const owner = ticket(db);
  jobs.enqueue(db, 'triage', 'unique-work', {}, owner);
  expect(() => jobs.enqueue(db, 'collect', 'unique-work', {}, owner)).toThrow(/different/);
  expect(() => jobs.enqueue(db, 'triage', 'unique-work', {}, ticket(db))).toThrow(/different/);
});

test.each([
  { field: undefined }, { field: NaN }, { field: Infinity }, { field: () => 'not JSON' }, { field: Symbol('not JSON') },
])('rejects payload values that JSON would silently drop or corrupt (%j)', (payload) => {
  const { path } = fixture();
  using db = openDb(path);
  expect(() => jobs.enqueue(db, 'triage', 'invalid-payload', payload)).toThrow(/JSON/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(0);
});

test.each([{ batch_ids: [0] }, { batch_ids: [-1] }, { batch_ids: [1.5] }, { batch_ids: ['1'] }, { batch_ids: null }])('rejects invalid forward batch ids without changing a parked head (%j)', (payload) => {
  const { path } = fixture();
  using db = openDb(path);
  const owner = ticket(db);
  const id = jobs.enqueue(db, 'forward', 'valid-head', { batch_ids: [1] }, owner);
  jobs.park(db, id, 'parked');
  expect(() => jobs.enqueue(db, 'forward', 'invalid-tail', payload, owner)).toThrow(/batch_ids/);
  expect(JSON.parse(String(row(db, id).payload))).toEqual({ batch_ids: [1] });
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(1);
});

test('defer validates replacement JSON before changing or clearing its lease', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  jobs.enqueue(db, 'collect', 'valid-poll', { turn: 1 });
  const job = claimed(db, cfg);
  expect(() => jobs.defer(db, job, '2026-11-06T00:00:10Z', { turn: NaN })).toThrow(/JSON/);
  expect(row(db, job.id)).toMatchObject({ state: 'running', lease_token: job.lease_token, payload: '{"turn":1}' });
});

test('samples the default claim clock after acquiring the SQLite writer lock', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  jobs.enqueue(db, 'triage', 'clock-after-lock', {});
  using clock = clockAfterBegin(db, '2026-11-06T00:00:30Z');
  const job = jobs.claim(db, cfg, 'after-wait');
  expect(job?.lease_until).toBe('2026-11-06T00:02:30.000000Z');
});

test.each(['renew', 'defer', 'fail', 'reserve'] as const)('cannot %s an expired owner after waiting for the SQLite writer lock', (operation) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const owner = ticket(db);
  jobs.enqueue(db, 'forward', 'expire-during-wait', { batch_ids: [1] }, owner);
  const job = claimed(db, cfg);
  const prepared = turn(db, owner, 'expiry-reservation');
  using clock = clockAfterBegin(db, '2026-11-06T00:02:00Z');
  const changed = operation === 'renew' ? jobs.renew(db, job.id, job.lease_token!)
    : operation === 'defer' ? jobs.defer(db, job, '2026-11-06T01:00:00Z')
      : operation === 'fail' ? jobs.fail(db, cfg, job, { status: 503 }, { dependency: 'must-not-change' })
        : jobs.reserveTurn(db, cfg, job, prepared);
  expect(changed).toBe(false);
  expect(row(db, job.id)).toMatchObject({ state: 'running', lease_token: job.lease_token, failures: 0, turn_id: null });
  expect(db.prepare('SELECT reserved_at FROM turn WHERE id=?').get(prepared)?.reserved_at).toBeNull();
  expect(db.prepare('SELECT COUNT(*) AS n FROM health').get()?.n).toBe(0);
});

test('failure classification cannot commit state after its current lease expires', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  jobs.enqueue(db, 'triage', 'expire-during-classification', {});
  const job = claimed(db, cfg);
  const error = { status: 503, get message() {
    vi.setSystemTime(new Date('2026-11-06T00:02:00Z'));
    return 'observed after expiry';
  } };
  expect(jobs.fail(db, cfg, job, error, { dependency: 'must-not-change' })).toBe(false);
  expect(row(db, job.id)).toMatchObject({ state: 'running', failures: 0 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM health').get()?.n).toBe(0);
});

test('nested aggregate connection errors take precedence over fetch TypeError', () => {
  const error = new TypeError('fetch failed', { cause: new AggregateError([
    Object.assign(new Error('Refused IPv6'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('Refused IPv4'), { code: 'ECONNREFUSED' }),
  ]) });
  expect(jobs.classify(error).error_class).toBe('dependency');
});

test('concurrent triage claims cannot exceed the global triage cap', async () => {
  const { path, cfg } = fixture({ triage_concurrency: 2 });
  using db = openDb(path);
  for (let n = 0; n < 5; n++) jobs.enqueue(db, 'triage', `triage-race:${n}`, {});
  const results = await raceClaims(cfg, AT, 5);
  expect(results.filter((id) => id !== null)).toHaveLength(2);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='triage' AND state='running'").get()?.n).toBe(2);
});
