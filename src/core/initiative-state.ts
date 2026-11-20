import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { utc } from './time.ts';
import type { Explainer, GuideState, InitiativesState, InitiativeSummary, InitiativeView } from '../lib/web-types.ts';

// The Overview page's side of the initiatives: stored summaries, the refresh request and page opens, all in the setting
// table. No provider or vault access here, so the web routes stay off the model runtime.

// A run marked running longer than this ended without clearing the mark (daemon stopped mid-run)
const STALE_RUN_MS = 20 * 60_000;

export interface Stored { at: string | null; summary: InitiativeSummary | null; error: string | null; error_at: string | null }

export function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Weekdays after since, up to and including today
export function workingDays(since: string, today: string): number {
  let count = 0;
  for (let day = shiftDay(since, 1); day <= today && count < 400; day = shiftDay(day, 1)) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

export function localTime(at: number, timezone: string): { day: string; hour: number; weekend: boolean } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(at).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun' };
}

export function readSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM setting WHERE key=?').get(key);
  return row ? String(row.value) : null;
}

export function writeSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO setting(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key, value, utc());
}

export function stored(db: DatabaseSync, id: string): Stored {
  try { return JSON.parse(readSetting(db, `initiative:${id}`) ?? 'null') as Stored ?? { at: null, summary: null, error: null, error_at: null }; }
  catch { return { at: null, summary: null, error: null, error_at: null }; }
}

export function requestRefresh(db: DatabaseSync): void { writeSetting(db, 'initiatives.requested', utc()); }

// One count per page open and day, for the pilot's use test
export function markSeen(db: DatabaseSync, cfg: Config, at = Date.now()): Record<string, number> {
  const day = localTime(at, cfg.overview.timezone).day;
  let views: Record<string, number> = {};
  try { views = JSON.parse(readSetting(db, 'initiatives.views') ?? '{}') as Record<string, number>; } catch { /* start over */ }
  views[day] = (views[day] ?? 0) + 1;
  writeSetting(db, 'initiatives.views', JSON.stringify(views));
  return views;
}

export function readInitiatives(db: DatabaseSync, cfg: Config, at = Date.now()): InitiativesState {
  const today = localTime(at, cfg.overview.timezone).day;
  const running = readSetting(db, 'initiatives.running');
  let views: Record<string, number> = {};
  try { views = JSON.parse(readSetting(db, 'initiatives.views') ?? '{}') as Record<string, number>; } catch { /* none counted */ }
  const initiatives = Object.entries(cfg.initiatives).map(([id, initiative]): InitiativeView => {
    const record = stored(db, id);
    const summary = record.summary && { ...record.summary, waits: record.summary.waits.map((wait) => ({ ...wait, days: workingDays(wait.since, today) })) };
    return { id, title: initiative.title, client: initiative.client, note: initiative.note, at: record.at, summary, error: record.error, error_at: record.error_at };
  });
  return { initiatives, today, views, requested: !!readSetting(db, 'initiatives.requested'),
    refreshing: !!running && at - Date.parse(running) < STALE_RUN_MS, providers: cfg.triage.providers.length > 0 };
}

// Guide of an initiative: setting explainer:<id> holds the last guide, its source note mtime and the last error;
// explainer.requested:<id> asks the daemon for a new one; explainer.running:<id> marks a run in progress
export interface StoredExplainer { at: string | null; explainer: Explainer | null; error: string | null; error_at: string | null; note_mtime: number | null }

export function storedExplainer(db: DatabaseSync, id: string): StoredExplainer {
  const empty: StoredExplainer = { at: null, explainer: null, error: null, error_at: null, note_mtime: null };
  try { return { ...empty, ...(JSON.parse(readSetting(db, `explainer:${id}`) ?? 'null') as StoredExplainer | null ?? {}) }; }
  catch { return empty; }
}

export function requestExplainer(db: DatabaseSync, id: string): void { writeSetting(db, `explainer.requested:${id}`, utc()); }

export function readGuide(db: DatabaseSync, cfg: Config, id: string, at = Date.now()): GuideState | null {
  const state = readInitiatives(db, cfg, at);
  const initiative = state.initiatives.find((item) => item.id === id);
  if (!initiative) return null;
  const record = storedExplainer(db, id);
  const running = readSetting(db, `explainer.running:${id}`);
  return { initiative, today: state.today, at: record.at, explainer: record.explainer, error: record.error, error_at: record.error_at,
    requested: !!readSetting(db, `explainer.requested:${id}`), running: !!running && at - Date.parse(running) < STALE_RUN_MS, providers: state.providers };
}