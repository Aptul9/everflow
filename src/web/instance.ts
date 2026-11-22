import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from '../core/config.ts';
import type { ChatToken } from './chat-gate.ts';
import type { ChatFiles } from './chat-files.ts';
import type { ClientChats } from '../core/client-chat.ts';
import type { Limiter, Sessions } from './login.ts';
import type { Oidc } from './oidc.ts';

export interface WebInstance {
  config: Config;
  configPath: string;
  port: number;
  token: string;
  // Present when [web] public_origin is set: requests under that host need a signed-in session. `password` is the fallback
  // sign-in (EVERFLOW_PASSWORD_LOGIN), `oidc` the EverID one (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET); at least one is on
  login?: { sessions: Sessions; limiter: Limiter; check: (user: string, password: string) => boolean; password: boolean; oidc?: Pick<Oidc, 'start' | 'finish' | 'logout'> };
  // Present when [web] chat_origin is set: the OpenChamber client token the chat host's gate hands to Caddy, and the
  // session folder the page's chat view opens with; page fetches OpenChamber's chat view for the bridge (chat-bridge.ts)
  chat?: Pick<ChatToken, 'token' | 'open' | 'page'>;
  // With chat: the files the ticket's chat wrote, for the viewer beside the chat, and any other it names when clicked
  files?: Pick<ChatFiles, 'list' | 'read' | 'describe'>;
  // With chat: the client's chat of the day on the Overview and the guide (client-chat.ts)
  clientChat?: Pick<ClientChats, 'open' | 'status'>;
}

const key = Symbol.for('everflow.web.instance');
const owner = process as NodeJS.Process & { [key]?: WebInstance };

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function instance(): WebInstance {
  const current = owner[key];
  if (!current) throw new HttpError(503, 'instance.unavailable', 'Explicit initialized web instance required');
  return current;
}

export function initialize(current: WebInstance): void {
  if (owner[key]) throw new Error('A web instance already owns this process');
  if (!isAbsolute(current.configPath) || current.configPath !== current.config._config_path
    || !isAbsolute(current.config.db.path) || !Number.isInteger(current.port) || current.port < 1 || current.port > 65535
    || !/^[a-f0-9]{64}$/.test(current.token)) throw new Error('Invalid explicit web instance');
  using db = new DatabaseSync(current.config.db.path, { readOnly: true, timeout: 30_000 });
  if (db.prepare('PRAGMA user_version').get()!.user_version !== 2
    || !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ticket'").get()
    || !db.prepare('PRAGMA table_info(ticket)').all().some((column) => column.name === 'session_title')
    || !db.prepare('PRAGMA table_info(conversation)').all().some((column) => column.name === 'muted_until')
    || !db.prepare('PRAGMA table_info(batch)').all().some((column) => column.name === 'cleared_at')
    || !db.prepare('PRAGMA table_info(ticket)').all().some((column) => column.name === 'cleared_at')) {
    throw new Error('Web instance requires an initialized current database');
  }
  owner[key] = current;
}

export function release(current: WebInstance): void {
  if (owner[key] === current) delete owner[key];
}

export function withDatabase<T>(write: boolean, operation: (db: DatabaseSync, current: WebInstance) => T): T {
  const current = instance();
  if (!existsSync(/* turbopackIgnore: true */ current.config.db.path)) throw new HttpError(503, 'instance.unavailable', 'Initialized database is missing');
  using db = new DatabaseSync(current.config.db.path, { readOnly: !write, timeout: 30_000 });
  // Requests never initialize, migrate or refine a database.
  if (db.prepare('PRAGMA user_version').get()!.user_version !== 2) throw new HttpError(503, 'instance.schema', 'Initialized database required');
  if (!write) db.exec('BEGIN');
  try { return operation(db, current); }
  finally { if (db.isTransaction) db.exec('ROLLBACK'); }
}
