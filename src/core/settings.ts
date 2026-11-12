import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { transaction } from './db.ts';
import { TicketError } from './tickets.ts';
import { utc } from './time.ts';

export const SETTING_KEYS = ['triage.model', 'triage.effort', 'chat.model', 'chat.effort'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

// Effort levels Meridian and OpenCode accept; anything else is refused, never silently dropped
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface ModelChoice { model: string; effort: string | null; default_model: string; overridden: boolean }

function read(db: DatabaseSync, key: SettingKey): string | null {
  const row = db.prepare('SELECT value FROM setting WHERE key=?').get(key);
  return row ? String(row.value) : null;
}

// What the next triage call or new ticket chat runs with: the page choice, else the config default.
// Both read provider/model; for triage the provider is the account tried first, a provider that is no longer a triage route counts as no choice.
export function modelChoice(db: DatabaseSync, cfg: Config, scope: 'triage' | 'chat'): ModelChoice {
  const routes = cfg.triage.providers;
  const routed = (model: string) => model.includes('/') || !routes[0] ? model : `${routes[0]}/${model}`;
  const fallback = scope === 'triage' ? routed(cfg.triage.model) : cfg.opencode.model;
  const stored = read(db, `${scope}.model`);
  const model = scope === 'chat' ? stored || fallback
    : stored && (!stored.includes('/') || routes.includes(stored.slice(0, stored.indexOf('/')))) ? routed(stored) : fallback;
  const effort = read(db, `${scope}.effort`) || null;
  return { model, effort, default_model: fallback, overridden: model !== fallback || effort !== null };
}

// Triage routes in the order they are tried, the chosen account first, and the model id the provider takes
export function triageRoute(cfg: Config, model: string): { routes: string[]; model: string } {
  const configured = [...new Set(cfg.triage.providers)];
  const at = model.indexOf('/');
  if (at < 0) return { routes: configured, model };
  const first = model.slice(0, at);
  return { routes: [first, ...configured.filter((id) => id !== first)], model: model.slice(at + 1) };
}

export interface ModelOption { id: string; name: string; efforts: string[] }
// accounts: provider id to its display name, the account a model runs on
export interface ModelOptions { chat: ModelOption[]; accounts: Record<string, string>; at: string | null; error: string | null; requested_at: string | null }

function json<T>(db: DatabaseSync, key: string): T | null {
  const row = db.prepare('SELECT value FROM setting WHERE key=?').get(key);
  try { return row ? JSON.parse(String(row.value)) as T : null; } catch { return null; }
}

function put(db: DatabaseSync, key: string, value: string, at?: string): void {
  db.prepare('INSERT INTO setting(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key, value, utc(at));
}

// Lists the page offers in its pickers; the daemon fills them only when the page asks, so it never calls out unprompted
export function readModelOptions(db: DatabaseSync): ModelOptions {
  const stored = json<Omit<ModelOptions, 'requested_at'>>(db, 'options.models');
  const requested = db.prepare("SELECT value FROM setting WHERE key='options.requested'").get();
  // Lists stored before account names existed count as stale, so the page asks for new ones
  return { chat: stored?.chat ?? [], accounts: stored?.accounts ?? {}, at: stored?.accounts ? stored.at : null,
    error: stored?.error ?? null, requested_at: requested ? String(requested.value) : null };
}

export function requestModelOptions(db: DatabaseSync, at?: string): string {
  put(db, 'options.requested', utc(at), at);
  return 'options.models';
}

export function takeModelRequest(db: DatabaseSync): boolean {
  return transaction(db, () => db.prepare("DELETE FROM setting WHERE key='options.requested'").run().changes > 0);
}

export function storeModelOptions(db: DatabaseSync, value: Omit<ModelOptions, 'requested_at'>, at?: string): void {
  put(db, 'options.models', JSON.stringify(value), at);
}

// Empty value goes back to the config default
export function saveSetting(db: DatabaseSync, key: string, value: string, at?: string): SettingKey {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new TicketError('ticket.invalid-input', `Unknown setting ${key}`);
  const clean = value.trim();
  // Chat effort is the model's own variant id (some list `none`); triage effort goes to Meridian, which takes only these
  if (clean && key === 'triage.effort' && !(EFFORTS as readonly string[]).includes(clean)) throw new TicketError('ticket.invalid-input', `Unknown effort ${clean}`);
  if (clean && key === 'chat.effort' && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(clean)) throw new TicketError('ticket.invalid-input', `Unknown effort ${clean}`);
  if (clean && key === 'chat.model' && !/^[\w.-]+\/[\w.:-]+$/.test(clean)) throw new TicketError('ticket.invalid-input', 'Chat model must be provider/model');
  if (clean && key === 'triage.model' && !/^([\w.-]+\/)?[\w.:-]+$/.test(clean)) throw new TicketError('ticket.invalid-input', 'Triage model must be provider/model or a model id');
  transaction(db, () => {
    if (clean) db.prepare('INSERT INTO setting(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key, clean, utc(at));
    else db.prepare('DELETE FROM setting WHERE key=?').run(key);
  });
  return key as SettingKey;
}
