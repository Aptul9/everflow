import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../src/core/config.ts';
import { openDb } from '../src/core/db.ts';
import { applySessionEvent, reconcileTitles, RETITLE_WAKE, retitlePass, startRetitler, startSessionEvents, syncNow } from '../src/core/retitle.ts';
import { boardColumn, stageTitle } from '../src/core/tickets.ts';
import type { Stage } from '../src/core/tickets.ts';
import { readState } from '../src/web/state.ts';
import { scratch } from './support.ts';

const AT = '2026-11-13T10:00:00.000Z';
afterEach(() => { delete (globalThis as Record<symbol, unknown>)[RETITLE_WAKE]; });

function fixture() {
  const files = scratch('retitle-');
  const db = openDb(files.path);
  return { ...files, db, cfg: loadConfig(files.config) };
}

function ticket(db: ReturnType<typeof openDb>, extra: { lifecycle?: string; report?: string | null; session?: string | null; title?: string } = {}) {
  const id = Number(db.prepare(`INSERT INTO ticket(title,lifecycle,report,session_id,approved_at,created_at,closed_at) VALUES (?,?,?,?,?,?,?)`)
    .run(extra.title ?? 'Synthetic', extra.lifecycle ?? 'active', extra.report ?? null, extra.session === undefined ? `ses_${Math.random().toString(36).slice(2)}` : extra.session,
      AT, AT, ['done', 'dismissed'].includes(extra.lifecycle ?? '') ? AT : null).lastInsertRowid);
  return id;
}

const marks = (db: ReturnType<typeof openDb>) => db.prepare('SELECT ticket FROM stage_dirty ORDER BY ticket').all().map((row) => Number(row.ticket));
const clear = (db: ReturnType<typeof openDb>) => db.exec('DELETE FROM stage_dirty');

function fakePeer(titles = new Map<string, string>(), options: { fail?: Error } = {}) {
  const calls: string[] = [];
  return {
    calls, titles,
    rename: async (session: string, title: string) => { calls.push(`rename ${session} ${title}`); if (options.fail) throw options.fail; titles.set(session, title); return {} as never; },
    get: async (session: string) => { calls.push(`get ${session}`); return { title: titles.get(session) } as never; },
  };
}

test('the title word is the board column: Idle reads Working, dismissed reads Skipped, and readState groups by the same word', () => {
  const cases: [Stage, string, string][] = [['Idle', 'active', 'Working'], ['Working', 'active', 'Working'], ['Needs you', 'active', 'Needs you'],
    ['Waiting on them', 'active', 'Waiting on them'], ['Failed', 'active', 'Failed'], ['Done', 'done', 'Done'], ['Dismissed', 'dismissed', 'Skipped'],
    ['Working', 'done', 'Done'], ['Failed', 'dismissed', 'Skipped']];
  for (const [stage, lifecycle, column] of cases) expect(boardColumn(stage, lifecycle as never)).toBe(column);
  const f = fixture();
  const idle = ticket(f.db), needs = ticket(f.db, { report: 'needs_you' }), waiting = ticket(f.db, { report: 'waiting_them' });
  const done = ticket(f.db, { lifecycle: 'done', report: 'done' }), skipped = ticket(f.db, { lifecycle: 'dismissed' });
  const state = readState(f.db, f.cfg, new Date(AT));
  const word = { needs_you: 'Needs you', working: 'Working', waiting_them: 'Waiting on them', failed: 'Failed', done_today: 'Done', skipped: 'Skipped' } as const;
  for (const id of [idle, needs, waiting, done, skipped]) {
    const group = (Object.keys(state.groups) as (keyof typeof word)[]).find((key) => state.groups[key].some((card) => card.id === id))!;
    expect(stageTitle(f.db, id)).toBe(`[${word[group]}] #${id} Synthetic`);
  }
});

test('writes that can move a card mark its ticket once; other writes do not', () => {
  const f = fixture();
  const id = ticket(f.db);
  clear(f.db);
  f.db.prepare("UPDATE ticket SET summary='x',ask='y' WHERE id=?").run(id);
  f.db.prepare("UPDATE ticket SET report=NULL,chat_running_at=NULL WHERE id=?").run(id);
  expect(marks(f.db)).toEqual([]);
  for (const sql of ["UPDATE ticket SET report='needs_you' WHERE id=?", "UPDATE ticket SET chat_running_at='x' WHERE id=?", "UPDATE ticket SET lifecycle='done' WHERE id=?",
    "UPDATE ticket SET title='Renamed' WHERE id=?"]) {
    f.db.prepare(sql).run(id);
    expect(marks(f.db)).toEqual([id]);
    clear(f.db);
  }
  const job = Number(f.db.prepare("INSERT INTO job(kind,key,ticket,next_at,created_at,updated_at) VALUES ('forward','k',?,?,?,?)").run(id, AT, AT, AT).lastInsertRowid);
  expect(marks(f.db)).toEqual([id]); clear(f.db);
  f.db.prepare("UPDATE job SET next_at=? WHERE id=?").run(AT, job);
  expect(marks(f.db)).toEqual([]);
  f.db.prepare("UPDATE job SET state='running' WHERE id=?").run(job);
  expect(marks(f.db)).toEqual([id]); clear(f.db);
  f.db.prepare("INSERT INTO job(kind,key,next_at,created_at,updated_at) VALUES ('triage','t',?,?,?)").run(AT, AT, AT);
  expect(marks(f.db)).toEqual([]);
  const turn = Number(f.db.prepare("INSERT INTO turn(ticket,kind,prompt_id,text,session_id,created_at) VALUES (?,'brief','p','t','s',?)").run(id, AT).lastInsertRowid);
  expect(marks(f.db)).toEqual([id]); clear(f.db);
  f.db.prepare("UPDATE turn SET state='done' WHERE id=?").run(turn);
  expect(marks(f.db)).toEqual([id]);
});

test('a fresh database marks every chat once so existing titles move to column names', () => {
  const files = scratch('retitle-first-');
  { using db = openDb(files.path); db.exec('DROP TABLE stage_dirty'); ticket(db); ticket(db, { session: null }); }
  using db = openDb(files.path);
  expect(db.prepare('SELECT COUNT(*) AS n FROM stage_dirty').get()!.n).toBe(1);
  using again = openDb(files.path);
  expect(again.prepare('SELECT COUNT(*) AS n FROM stage_dirty').get()!.n).toBe(1);
});

test('a pass renames stale titles once, clears matching ones without a call, and waits while an input runs', async () => {
  const f = fixture();
  const stale = ticket(f.db, { report: 'needs_you' }), fine = ticket(f.db), busy = ticket(f.db), gone = ticket(f.db, { session: null });
  f.db.prepare('UPDATE ticket SET session_title=? WHERE id=?').run(stageTitle(f.db, fine), fine);
  f.db.prepare("INSERT INTO job(kind,key,ticket,state,next_at,created_at,updated_at) VALUES ('collect','c',?,'running',?,?,?)").run(busy, AT, AT, AT);
  for (const id of [stale, fine, busy, gone]) f.db.prepare('INSERT OR REPLACE INTO stage_dirty(ticket,at) VALUES (?,?)').run(id, AT);
  const peer = fakePeer();
  await retitlePass(f.db, peer);
  const session = String(f.db.prepare('SELECT session_id FROM ticket WHERE id=?').get(stale)!.session_id);
  expect(peer.calls).toEqual([`rename ${session} [Needs you] #${stale} Synthetic`, `get ${session}`]);
  expect(f.db.prepare('SELECT session_title FROM ticket WHERE id=?').get(stale)!.session_title).toBe(`[Needs you] #${stale} Synthetic`);
  expect(marks(f.db)).toEqual([busy]);
});

test('a failed rename keeps the mark; a deleted chat drops it', async () => {
  const f = fixture();
  const id = ticket(f.db, { report: 'needs_you' });
  f.db.prepare('INSERT INTO stage_dirty(ticket,at) VALUES (?,?)').run(id, AT);
  await expect(retitlePass(f.db, fakePeer(new Map(), { fail: new Error('OpenCode HTTP 503') }))).rejects.toThrow('503');
  expect(marks(f.db)).toContain(id);
  await retitlePass(f.db, fakePeer(new Map(), { fail: Object.assign(new Error('OpenCode HTTP 404'), { resource: 'session' }) }));
  expect(marks(f.db)).toEqual([]);
});

test('the worker drains on wake, retries a failure after backoff, and registers its wake process-wide', async () => {
  const f = fixture();
  const id = ticket(f.db, { report: 'waiting_them' });
  f.db.prepare('INSERT INTO stage_dirty(ticket,at) VALUES (?,?)').run(id, AT);
  let failing = true;
  const titles = new Map<string, string>();
  const logs: unknown[] = [];
  const worker = startRetitler(f.cfg, f.db, { log: (event) => logs.push(event),
    peer: () => ({ ...fakePeer(titles, failing ? { fail: new Error('fetch failed') } : {}) }) });
  try {
    (globalThis as Record<symbol, () => void>)[RETITLE_WAKE]!();
    await delay(50);
    expect(marks(f.db)).toContain(id);
    expect(logs).toEqual([expect.objectContaining({ code: 'title.retry' })]);
    failing = false;
    await delay(1200);
    expect(marks(f.db)).toEqual([]);
    expect(f.db.prepare('SELECT session_title FROM ticket WHERE id=?').get(id)!.session_title).toBe(`[Waiting on them] #${id} Synthetic`);
  } finally { worker.close(); }
  expect((globalThis as Record<symbol, unknown>)[RETITLE_WAKE]).toBeUndefined();
});

test('session events: a started turn reads Working, a finished one makes its sync due now, a foreign rename is put back, our echo and strangers are ignored', () => {
  const f = fixture();
  const id = ticket(f.db, { report: 'needs_you' });
  const session = String(f.db.prepare('SELECT session_id FROM ticket WHERE id=?').get(id)!.session_id);
  f.db.prepare('UPDATE ticket SET session_title=? WHERE id=?').run(stageTitle(f.db, id), id);
  clear(f.db);
  expect(applySessionEvent(f.db, { type: 'session.execution.started', data: { sessionID: 'ses_other' } }, AT)).toBe(false);
  expect(applySessionEvent(f.db, { type: 'session.execution.started', data: { sessionID: session } }, AT)).toBe(true);
  expect(stageTitle(f.db, id)).toBe(`[Working] #${id} Synthetic`);
  expect(marks(f.db)).toEqual([id]); clear(f.db);
  expect(applySessionEvent(f.db, { type: 'session.status', data: { sessionID: session, status: { type: 'idle' } } }, AT)).toBe(true);
  expect(f.db.prepare('SELECT chat_running_at FROM ticket WHERE id=?').get(id)!.chat_running_at).toBeNull();
  expect({ ...f.db.prepare("SELECT state,next_at FROM job WHERE kind='sync' AND ticket=?").get(id) }).toEqual({ state: 'queued', next_at: expect.any(String) });
  const derived = stageTitle(f.db, id);
  f.db.prepare('UPDATE ticket SET session_title=? WHERE id=?').run(derived, id);
  clear(f.db);
  expect(applySessionEvent(f.db, { type: 'session.renamed', data: { sessionID: session, title: derived } }, AT)).toBe(false);
  expect(marks(f.db)).toEqual([]);
  expect(applySessionEvent(f.db, { type: 'session.renamed', data: { sessionID: session, title: 'Something else' } }, AT)).toBe(true);
  expect(marks(f.db)).toEqual([id]);
  expect(f.db.prepare('SELECT session_title FROM ticket WHERE id=?').get(id)!.session_title).toBe('Something else');
});

test('sync now requeues a finished sync with fresh counters and leaves pending input to its collector', () => {
  const f = fixture();
  const id = ticket(f.db);
  const day = AT.slice(0, 10);
  f.db.prepare(`INSERT INTO job(kind,key,ticket,state,failures,attempts,next_at,created_at,updated_at) VALUES ('sync',?,?,'done',7,2,'2026-11-13T11:00:00.000Z',?,?)`)
    .run(`sync:ticket:${id}:${day}`, id, AT, AT);
  syncNow(f.db, id, AT);
  expect({ ...f.db.prepare("SELECT state,failures,attempts,next_at FROM job WHERE kind='sync'").get() }).toEqual({ state: 'queued', failures: 0, attempts: 0, next_at: AT });
  const other = ticket(f.db);
  f.db.prepare("INSERT INTO job(kind,key,ticket,state,next_at,created_at,updated_at) VALUES ('forward','in',?,'queued',?,?,?)").run(other, AT, AT, AT);
  syncNow(f.db, other, AT);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='sync' AND ticket=?").get(other)!.n).toBe(0);
});

test('reconcile marks stale stored titles and re-syncs chats last seen running', () => {
  const f = fixture();
  const fresh = ticket(f.db), stale = ticket(f.db), running = ticket(f.db);
  f.db.prepare('UPDATE ticket SET session_title=? WHERE id=?').run(stageTitle(f.db, fresh), fresh);
  f.db.prepare("UPDATE ticket SET session_title='old' WHERE id=?").run(stale);
  f.db.prepare("UPDATE ticket SET session_title=?,chat_running_at=? WHERE id=?").run('x', AT, running);
  clear(f.db);
  reconcileTitles(f.db, AT);
  expect(marks(f.db)).toEqual([stale, running]);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='sync' AND ticket=?").get(running)!.n).toBe(1);
});

test('the event stream reconnects after a drop or a silent stream, marks health, and reconciles on every connect', async () => {
  const f = fixture();
  const id = ticket(f.db, { report: 'needs_you' });
  const session = String(f.db.prepare('SELECT session_id FROM ticket WHERE id=?').get(id)!.session_id);
  let connects = 0, wakes = 0;
  const logs: unknown[] = [];
  const streams: ((signal: AbortSignal, activity: () => void) => AsyncGenerator<unknown>)[] = [
    async function* () { yield { type: 'server.connected', data: {} }; throw new Error('socket hang up'); },
    async function* (signal) { yield { type: 'server.connected', data: {} }; await new Promise((resolve) => signal.addEventListener('abort', resolve)); },
    async function* (signal, activity) {
      yield { type: 'server.connected', data: {} }; yield { type: 'session.execution.started', data: { sessionID: session } };
      // Keepalive frames keep a quiet stream alive past the watchdog
      const keepalive = setInterval(activity, 50);
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
      clearInterval(keepalive);
    },
  ];
  const events = startSessionEvents(f.cfg, f.db, { wake: () => { wakes++; }, log: (event) => logs.push(event), idleMs: 200, maxBackoffMs: 20,
    peer: () => ({ events: (signal: AbortSignal, activity: () => void) => streams[Math.min(connects++, streams.length - 1)]!(signal, activity) as never }) });
  try {
    for (let i = 0; i < 100 && f.db.prepare('SELECT chat_running_at FROM ticket WHERE id=?').get(id)!.chat_running_at === null; i++) await delay(20);
    expect(f.db.prepare('SELECT chat_running_at FROM ticket WHERE id=?').get(id)!.chat_running_at).not.toBeNull();
    expect(connects).toBeGreaterThanOrEqual(3);
    expect(wakes).toBeGreaterThanOrEqual(4);
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'events.disconnected' })]));
  } finally { await events.close(); }
  expect(f.db.prepare("SELECT state FROM health WHERE dependency='opencode:events'").get()!.state).toBe('ok');
});
