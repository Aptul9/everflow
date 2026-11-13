import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.ts';
import { transaction } from './db.ts';
import { enqueue, hasPendingInput, healthError, healthOk } from './jobs.ts';
import { connect } from './opencode.ts';
import type { Peer } from './opencode.ts';
import { stageTitle } from './tickets.ts';
import { utc } from './time.ts';

// Page actions run in Next's own module graph, so the wake function is found through a process-wide symbol
export const RETITLE_WAKE = Symbol.for('everflow.retitle.wake');
export function wakeRetitle(): void { (globalThis as Record<symbol, (() => void) | undefined>)[RETITLE_WAKE]?.(); }

type Log = (event: { source: string; code: string; [key: string]: unknown }) => void;
const inputRunning = "SELECT 1 FROM job WHERE ticket=? AND state='running' AND kind IN ('collect','start_chat','forward')";
const mark = (db: DatabaseSync, ticket: number) => db.prepare('INSERT OR REPLACE INTO stage_dirty(ticket,at) VALUES (?,?)').run(ticket, utc());

/** Renames every marked ticket whose derived title differs from the last one written; a write meanwhile keeps the mark. */
export async function retitlePass(db: DatabaseSync, peer: Pick<Peer, 'get' | 'rename'>, signal?: AbortSignal): Promise<void> {
  for (const row of db.prepare('SELECT ticket FROM stage_dirty ORDER BY at,ticket').all()) {
    signal?.throwIfAborted();
    const ticket = Number(row.ticket);
    const owner = db.prepare('SELECT session_id,approved_at,session_title FROM ticket WHERE id=?').get(ticket);
    if (!owner?.session_id || !owner.approved_at) { db.prepare('DELETE FROM stage_dirty WHERE ticket=?').run(ticket); continue; }
    // The collector writes the title with its report; its job finishing marks the ticket again
    if (db.prepare(inputRunning).get(ticket)) continue;
    const session = String(owner.session_id), title = stageTitle(db, ticket);
    if (title !== owner.session_title) {
      try {
        await peer.rename(session, title, signal);
        if ((await peer.get(session, signal)).title !== title) throw Object.assign(new Error('OpenCode title PATCH was not observed'), { status: 503 });
      } catch (error) {
        // The chat was deleted in OpenChamber: nothing left to name
        if ((error as { resource?: unknown }).resource === 'session') { db.prepare('DELETE FROM stage_dirty WHERE ticket=?').run(ticket); continue; }
        throw error;
      }
    }
    transaction(db, () => {
      if (stageTitle(db, ticket) !== title) return;
      db.prepare('UPDATE ticket SET session_title=? WHERE id=?').run(title, ticket);
      db.prepare('DELETE FROM stage_dirty WHERE ticket=?').run(ticket);
    });
  }
}

export function startRetitler(cfg: Config, db: DatabaseSync, options: { log: Log; peer?: () => Pick<Peer, 'get' | 'rename'> }) {
  const peer = options.peer ?? (() => connect(cfg, cfg.opencode.timeout_seconds === undefined ? {} : { timeoutMs: cfg.opencode.timeout_seconds * 1000 }));
  const controller = new AbortController();
  let running = false, again = false, failures = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    if (controller.signal.aborted) return;
    if (running) { again = true; return; }
    if (timer) return;
    void run();
  };
  const run = async () => {
    running = true;
    try {
      do { again = false; await retitlePass(db, peer(), controller.signal); } while (again && !controller.signal.aborted);
      failures = 0;
    } catch (error) {
      if (controller.signal.aborted) return;
      // Marks stay; retry backs off on consecutive failures only and writes no per-attempt history
      if (failures++ === 0) options.log({ source: 'daemon', code: 'title.retry', message: String((error as Error)?.message ?? error).slice(0, 200) });
      timer = setTimeout(() => { timer = undefined; wake(); }, Math.min(30_000, 1000 * 2 ** (failures - 1)));
      timer.unref();
    } finally {
      running = false;
      if (again && !timer && !controller.signal.aborted) wake();
    }
  };
  (globalThis as Record<symbol, unknown>)[RETITLE_WAKE] = wake;
  return {
    wake,
    close() {
      controller.abort(); clearTimeout(timer);
      const registry = globalThis as Record<symbol, unknown>;
      if (registry[RETITLE_WAKE] === wake) delete registry[RETITLE_WAKE];
    },
  };
}

/** Makes the ticket's sync due now, so a finished turn's STATUS moves its column without waiting for the interval. */
export function syncNow(db: DatabaseSync, ticket: number, at = utc()): void {
  transaction(db, () => {
    if (hasPendingInput(db, ticket)) return;
    const active = db.prepare("SELECT id,state FROM job WHERE kind='sync' AND ticket=? AND state IN ('queued','running')").get(ticket);
    if (active) { if (active.state === 'queued') db.prepare('UPDATE job SET next_at=?,updated_at=? WHERE id=? AND next_at>?').run(at, at, active.id!, at); return; }
    const key = `sync:ticket:${ticket}:${at.slice(0, 10)}`;
    const existing = db.prepare('SELECT id,state FROM job WHERE key=?').get(key);
    if (!existing) enqueue(db, 'sync', key, {}, ticket);
    else if (existing.state === 'done') db.prepare(`UPDATE job SET state='queued',payload='{}',attempts=0,failures=0,error_class=NULL,last_error=NULL,
      next_at=?,updated_at=? WHERE id=? AND state='done'`).run(at, at, existing.id!);
  });
}

/** After a (re)connect: marks every chat whose stored title is stale and re-syncs chats last seen running, for events missed meanwhile. */
export function reconcileTitles(db: DatabaseSync, at = utc()): void {
  for (const row of db.prepare(`SELECT id,session_title,chat_running_at FROM ticket WHERE session_id IS NOT NULL AND approved_at IS NOT NULL`).all()) {
    const ticket = Number(row.id);
    if (row.session_title !== stageTitle(db, ticket)) mark(db, ticket);
    if (row.chat_running_at) syncNow(db, ticket, at);
  }
}

type SessionEvent = { type: string; data?: { sessionID?: unknown; title?: unknown; status?: { type?: unknown } } };

/** Applies one OpenCode event to the ticket bound to its session. Returns whether anything may need a new title. */
export function applySessionEvent(db: DatabaseSync, event: SessionEvent, at = utc()): boolean {
  const session = event.data?.sessionID;
  if (typeof session !== 'string') return false;
  const owner = db.prepare('SELECT id,session_title FROM ticket WHERE session_id=? AND approved_at IS NOT NULL').get(session);
  if (!owner) return false;
  const ticket = Number(owner.id);
  const status = event.type === 'session.status' ? event.data?.status?.type : undefined;
  if (event.type === 'session.execution.started' || status === 'busy' || status === 'retry') {
    db.prepare('UPDATE ticket SET chat_running_at=COALESCE(chat_running_at,?) WHERE id=?').run(at, ticket);
  } else if (event.type === 'session.idle' || status === 'idle' || event.type === 'session.execution.succeeded'
    || event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted') {
    db.prepare('UPDATE ticket SET chat_running_at=NULL WHERE id=?').run(ticket);
    syncNow(db, ticket, at);
  } else if (event.type === 'session.renamed') {
    // The echo of our own rename matches; anything else is put back
    if (typeof event.data?.title !== 'string' || event.data.title === stageTitle(db, ticket)) return false;
    transaction(db, () => { db.prepare('UPDATE ticket SET session_title=? WHERE id=?').run(event.data!.title as string, ticket); mark(db, ticket); });
  } else return false;
  return true;
}

const STOPPED = Symbol('stopped');

/** Keeps one OpenCode event stream open, reconnecting with backoff, and when no frame (keepalives included) came for `idleMs`. */
export function startSessionEvents(cfg: Config, db: DatabaseSync, options: { wake: () => void; log: Log;
  peer?: () => Pick<Peer, 'events'>; idleMs?: number; maxBackoffMs?: number }) {
  const controller = new AbortController();
  const peer = options.peer ?? (() => connect(cfg, { timeoutMs: 2_147_483_647 }));
  const idleMs = options.idleMs ?? 60_000, maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const done = (async () => {
    let failures = 0;
    while (!controller.signal.aborted) {
      const cycle = new AbortController();
      const stop = () => cycle.abort();
      controller.signal.addEventListener('abort', stop, { once: true });
      let silent = false, watchdog: ReturnType<typeof setTimeout> | undefined;
      const alive = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { silent = true; stop(); }, idleMs); watchdog.unref(); };
      alive();
      const ended = new Promise<typeof STOPPED>((resolve) => cycle.signal.addEventListener('abort', () => resolve(STOPPED), { once: true }));
      try {
        const iterator = peer().events(cycle.signal, alive)[Symbol.asyncIterator]();
        try {
          for (;;) {
            // The stream notices an abort only on its next event, so the cycle ends on its own signal
            const next = await Promise.race([iterator.next(), ended]);
            if (next === STOPPED) { if (silent) throw new Error(`OpenCode event stream silent for ${idleMs} ms`); break; }
            alive();
            if (next.done) throw new Error('OpenCode event stream ended');
            const event = next.value as SessionEvent;
            if (event.type === 'server.connected') {
              failures = 0;
              healthOk(db, 'opencode:events');
              reconcileTitles(db);
              options.wake();
            } else if (applySessionEvent(db, event)) options.wake();
          }
        } finally { void iterator.return?.().catch(() => {}); }
      } catch (error) {
        if (!controller.signal.aborted) {
          failures++;
          healthError(db, cfg, 'opencode:events', error);
          if (failures === 1) options.log({ source: 'daemon', code: 'events.disconnected', message: String((error as Error)?.message ?? error).slice(0, 200) });
        }
      } finally {
        clearTimeout(watchdog);
        controller.signal.removeEventListener('abort', stop);
      }
      if (failures) await delay(Math.min(maxBackoffMs, 1000 * 2 ** (failures - 1)), undefined, { signal: controller.signal }).catch(() => {});
    }
  })();
  return { close: async () => { controller.abort(); await done; } };
}
