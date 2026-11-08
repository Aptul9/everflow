import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import sqlite, { DatabaseSync } from 'node:sqlite';
import { utc } from './time.ts';

const batchColumns = `
  id INTEGER PRIMARY KEY, conversation INTEGER NOT NULL REFERENCES conversation,
  work_item INTEGER, state TEXT NOT NULL, prompt_id TEXT, error TEXT,
  created_at TEXT NOT NULL, delivered_at TEXT, done_at TEXT,
  outcome TEXT, ticket INTEGER REFERENCES ticket`;

const schema = `
CREATE TABLE IF NOT EXISTS cursor (
  source TEXT NOT NULL, account TEXT NOT NULL, since TEXT NOT NULL,
  PRIMARY KEY (source, account));
CREATE TABLE IF NOT EXISTS conversation (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, native_id TEXT NOT NULL,
  title TEXT, approval TEXT NOT NULL DEFAULT 'approve', last_message_at TEXT, muted_until TEXT,
  UNIQUE (source, account, native_id));
CREATE TABLE IF NOT EXISTS person (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE, teams_oid TEXT UNIQUE, gchat_id TEXT UNIQUE, name TEXT);
CREATE TABLE IF NOT EXISTS message (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, message_id TEXT NOT NULL, native_id TEXT,
  conversation INTEGER NOT NULL REFERENCES conversation, person INTEGER REFERENCES person,
  sender TEXT, sender_name TEXT, sender_is_me INTEGER NOT NULL, sent_at TEXT NOT NULL,
  text TEXT, attachments TEXT, ref TEXT, batch INTEGER REFERENCES batch, stored_at TEXT NOT NULL,
  UNIQUE (source, message_id));
CREATE TABLE IF NOT EXISTS batch (${batchColumns});
CREATE TABLE IF NOT EXISTS triage_log (
  id INTEGER PRIMARY KEY, batch INTEGER REFERENCES batch, conversation INTEGER REFERENCES conversation,
  at TEXT NOT NULL, relevant INTEGER, assigned_to_me INTEGER, action TEXT, work_item TEXT,
  reason TEXT, confidence REAL, candidates TEXT, raw TEXT);
CREATE TABLE IF NOT EXISTS ticket (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL, client TEXT, summary TEXT NOT NULL DEFAULT '',
  ask TEXT NOT NULL DEFAULT '', proposal TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL DEFAULT 'proposed' CHECK (lifecycle IN ('proposed','active','done','dismissed')),
  session_id TEXT UNIQUE,
  report TEXT CHECK (report IN ('working','needs_you','waiting_them','blocked','done')),
  report_line TEXT, report_at TEXT, report_message_id TEXT, report_turn INTEGER REFERENCES turn,
  kb_notes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(kb_notes) AND json_type(kb_notes) = 'array'),
  confidence REAL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL, approved_at TEXT, closed_at TEXT, approval_note TEXT,
  last_activity_at TEXT, archived_at TEXT, session_title TEXT,
  maybe_ticket INTEGER REFERENCES ticket CHECK (maybe_ticket <> id),
  merged_into INTEGER REFERENCES ticket CHECK (merged_into <> id));
CREATE TABLE IF NOT EXISTS ticket_conversation (
  ticket INTEGER NOT NULL REFERENCES ticket, conversation INTEGER NOT NULL REFERENCES conversation,
  kind TEXT NOT NULL CHECK (kind IN ('primary','linked','context')),
  "by" TEXT NOT NULL CHECK ("by" IN ('rule','agent','you','chat')),
  created_at TEXT NOT NULL, PRIMARY KEY (ticket, conversation));
CREATE UNIQUE INDEX IF NOT EXISTS conversation_route ON ticket_conversation(conversation)
  WHERE kind IN ('primary','linked');
CREATE TABLE IF NOT EXISTS ticket_ref (
  id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES ticket,
  kind TEXT NOT NULL CHECK (kind IN ('jira','snow','github_pr','gitlab_mr','ado_pr')),
  key TEXT NOT NULL, url TEXT,
  seen_in TEXT NOT NULL CHECK (seen_in IN ('message','chat')),
  UNIQUE (ticket, kind, key));
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES ticket, at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message','triage','ref','status','comment','approval','chat','failure','merge')),
  actor TEXT NOT NULL, body TEXT NOT NULL, link TEXT, event_key TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS job (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('triage','start_chat','forward','collect','sync','archive','purge')),
  key TEXT NOT NULL UNIQUE, ticket INTEGER REFERENCES ticket,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','parked','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  next_at TEXT NOT NULL, lease_until TEXT, lease_token TEXT, run_id TEXT,
  lease_seconds INTEGER CHECK (lease_seconds > 0),
  reserved_at TEXT, turn_id INTEGER REFERENCES turn, merged_into INTEGER REFERENCES job,
  error_class TEXT CHECK (error_class IN ('dependency','job','unknown')), last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (kind NOT IN ('sync','archive','purge') OR state <> 'parked'));
CREATE INDEX IF NOT EXISTS job_ready ON job(state, next_at, id);
CREATE INDEX IF NOT EXISTS job_ticket_order ON job(ticket, id);
CREATE UNIQUE INDEX IF NOT EXISTS job_turn ON job(turn_id) WHERE turn_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS turn (
  id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES ticket,
  kind TEXT NOT NULL CHECK (kind IN ('brief','forward','recovery','note')),
  batch INTEGER REFERENCES batch, prompt_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL, session_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','admitted','running','done','cancelled')),
  outcome TEXT CHECK (outcome IN ('succeeded','failed','interrupted','lost')),
  recovery_of INTEGER REFERENCES turn, input_turn INTEGER REFERENCES turn,
  recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
  context_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(context_ids) AND json_type(context_ids) = 'array'),
  batch_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(batch_ids) AND json_type(batch_ids) = 'array'),
  reserved_at TEXT, admitted_at TEXT, completed_at TEXT, created_at TEXT NOT NULL,
  error_class TEXT CHECK (error_class IN ('dependency','job','unknown')), last_error TEXT);
CREATE TRIGGER IF NOT EXISTS immutable_turn_input
BEFORE UPDATE OF ticket,kind,batch,prompt_id,text,session_id,context_ids,batch_ids,recovery_of,input_turn ON turn
WHEN NEW.ticket IS NOT OLD.ticket OR NEW.kind IS NOT OLD.kind OR NEW.batch IS NOT OLD.batch
  OR NEW.prompt_id IS NOT OLD.prompt_id OR NEW.text IS NOT OLD.text OR NEW.session_id IS NOT OLD.session_id
  OR NEW.context_ids IS NOT OLD.context_ids OR NEW.batch_ids IS NOT OLD.batch_ids OR NEW.recovery_of IS NOT OLD.recovery_of OR NEW.input_turn IS NOT OLD.input_turn
BEGIN SELECT RAISE(ABORT, 'turn target and input are immutable'); END;
CREATE TABLE IF NOT EXISTS health (
  dependency TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('ok','retrying','failing','stopped')),
  since TEXT NOT NULL, last_ok TEXT, last_error TEXT,
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND json_type(detail) = 'object'));
CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL,
  line TEXT NOT NULL CHECK (length(CAST(line AS BLOB)) <= 4096), error TEXT NOT NULL, at TEXT NOT NULL,
  replayed_at TEXT, truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)));
`;

function version(db: DatabaseSync): number {
  const value = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (value < 0 || value > 2) throw new Error(`Unsupported database schema version ${value}`);
  return value;
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table) !== undefined;
}

function empty(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() === undefined;
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  const savepoint = db.isTransaction ? `nested_${randomUUID().replaceAll('-', '')}` : null;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (result && typeof (result as { then?: unknown }).then === 'function') throw new TypeError('Transactions must be synchronous');
    db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK');
    throw error;
  }
}

function refineJobs(db: DatabaseSync): void {
  const additions = {
    lease_seconds: 'INTEGER CHECK (lease_seconds > 0)',
    reserved_at: 'TEXT',
    turn_id: 'INTEGER REFERENCES turn',
    merged_into: 'INTEGER REFERENCES job',
  };
  const columns = () => db.prepare('PRAGMA table_info(job)').all().map((column) => column.name);
  if (Object.keys(additions).every((name) => columns().includes(name))) return;
  transaction(db, () => {
    const existing = columns();
    for (const [name, definition] of Object.entries(additions)) {
      if (!existing.includes(name)) db.exec(`ALTER TABLE job ADD COLUMN ${name} ${definition}`);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS job_turn ON job(turn_id) WHERE turn_id IS NOT NULL');
  });
}

function refineChat(db: DatabaseSync): void {
  const has = (table: 'ticket' | 'turn', name: string) => db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name);
  if (has('ticket', 'session_title') && has('turn', 'batch_ids')) return;
  transaction(db, () => {
    if (!has('ticket', 'session_title')) db.exec('ALTER TABLE ticket ADD COLUMN session_title TEXT');
    if (!has('turn', 'batch_ids')) {
      db.exec(`ALTER TABLE turn ADD COLUMN batch_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(batch_ids) AND json_type(batch_ids) = 'array');
        UPDATE turn SET batch_ids=COALESCE((SELECT json_extract(payload,'$.batch_ids') FROM job WHERE turn_id=turn.id AND json_type(payload,'$.batch_ids')='array'),
          CASE WHEN batch IS NULL THEN '[]' ELSE json_array(batch) END);
        DROP TRIGGER immutable_turn_input`);
      db.exec(schema.slice(schema.indexOf('CREATE TRIGGER'), schema.indexOf('CREATE TABLE IF NOT EXISTS health')));
    }
  });
}

function refineConversation(db: DatabaseSync): void {
  if (db.prepare('PRAGMA table_info(conversation)').all().some((column) => column.name === 'muted_until')) return;
  transaction(db, () => db.exec('ALTER TABLE conversation ADD COLUMN muted_until TEXT'));
}

function scopeLegacyKeys(db: DatabaseSync): void {
  if (!db.prepare('PRAGMA table_info(message)').all().some((column) => column.name === 'native_id')) {
    db.exec('ALTER TABLE message ADD COLUMN native_id TEXT');
  }
  const rows = db.prepare(`SELECT m.id,m.message_id,COALESCE(m.native_id,m.message_id) AS native_id,c.account
    FROM message m JOIN conversation c ON c.id=m.conversation`, { readBigInts: true }).all();
  let prefix = `scope:${randomUUID()}:`;
  while (rows.some((row) => String(row.message_id).startsWith(prefix))) prefix = `scope:${randomUUID()}:`;
  const temporary = db.prepare('UPDATE message SET native_id=?,message_id=? WHERE id=?');
  for (const row of rows) temporary.run(row.native_id!, prefix + String(row.id), row.id!);
  const scoped = db.prepare('UPDATE message SET message_id=? WHERE id=?');
  for (const row of rows) scoped.run(JSON.stringify([String(row.account).toLowerCase(), row.native_id]), row.id!);
}

function upgrade(db: DatabaseSync, from: number): void {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      if (version(db) !== from) throw new Error('Database schema changed during backup');
      if (from === 0 && hasTable(db, 'message')) scopeLegacyKeys(db);
      if (hasTable(db, 'batch')) {
        // Keep the old parent name until the replacement exists so child FKs still name batch.
        db.exec(`CREATE TABLE batch_v2 (${batchColumns});
          INSERT INTO batch_v2(id,conversation,work_item,state,prompt_id,error,created_at,delivered_at,done_at,outcome)
            SELECT id,conversation,work_item,state,prompt_id,error,created_at,delivered_at,done_at,'historical' FROM batch;
          DROP TABLE batch;
          ALTER TABLE batch_v2 RENAME TO batch`);
      }
      db.exec(schema);
      for (const table of ['approval_request', 'approval_event', 'send_attempt', 'prompt_submission', 'draft', 'work_item_conversation', 'work_item']) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('Migration foreign key check failed');
      db.exec('PRAGMA user_version = 2');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 30_000 });
  try {
    const from = version(db);
    if (from === 0 && empty(db)) upgrade(db, 0);
    else if (from !== 2) throw new Error(`Schema version ${from} requires await migrate(path) before openDb(path)`);
    refineJobs(db);
    refineChat(db);
    refineConversation(db);
    db.exec('PRAGMA journal_mode = WAL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function migrate(path: string): Promise<string | null> {
  if (!existsSync(path)) {
    using db = openDb(path);
    return null;
  }
  let from: number;
  let saved: string | null = null;
  {
    using source = new DatabaseSync(path, { readOnly: true, timeout: 30_000 });
    from = version(source);
    if (from === 2) return null;
    if (!(from === 0 && empty(source))) {
      saved = `${path}.pre-v2-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.db`;
      closeSync(openSync(saved, 'wx'));
      await sqlite.backup(source, saved);
      using copy = new DatabaseSync(saved, { readOnly: true, timeout: 30_000 });
      if (copy.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || version(copy) !== from) {
        throw new Error(`Migration backup validation failed: ${saved}`);
      }
    }
  }
  using db = new DatabaseSync(path, { timeout: 30_000 });
  upgrade(db, from);
  return saved;
}

export function prepareStart(db: DatabaseSync, triageAfter?: string, at?: string): string {
  if (version(db) !== 2) throw new Error('prepareStart requires schema version 2');
  return transaction(db, () => {
    const row = db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get();
    const detail = row ? JSON.parse(String(row.detail)) as Record<string, unknown> : {};
    if (detail.triage_after !== undefined) {
      if (typeof detail.triage_after !== 'string') throw new Error('Invalid persisted triage_after');
      return utc(detail.triage_after);
    }
    if (detail.store_id !== undefined && (typeof detail.store_id !== 'string' || detail.store_id.length === 0)) {
      throw new Error('Invalid persisted store_id');
    }
    const started = utc(at);
    const cutoff = utc(triageAfter ?? started);
    const saved = { ...detail, store_id: detail.store_id ?? randomUUID(), triage_after: cutoff,
      first_started_at: detail.first_started_at ?? started };
    db.prepare(`INSERT INTO health(dependency,state,since,last_ok,detail) VALUES ('daemon','ok',?,?,?)
      ON CONFLICT(dependency) DO UPDATE SET detail=excluded.detail`).run(started, started, JSON.stringify(saved));

    const groups = new Map<bigint, bigint[]>();
    for (const message of db.prepare('SELECT id,conversation,stored_at FROM message WHERE batch IS NULL ORDER BY id', { readBigInts: true }).all()) {
      if (utc(String(message.stored_at)) >= cutoff) continue;
      const conversation = message.conversation as bigint;
      const ids = groups.get(conversation) ?? [];
      ids.push(message.id as bigint);
      groups.set(conversation, ids);
    }
    const batch = db.prepare(`INSERT INTO batch(conversation,state,created_at,done_at,outcome)
      VALUES (?,'done',?,?,'backlog')`);
    const assign = db.prepare('UPDATE message SET batch=? WHERE id=? AND batch IS NULL');
    for (const [conversation, ids] of groups) {
      const id = batch.run(conversation, started, started).lastInsertRowid;
      for (const message of ids) assign.run(id, message);
    }
    return cutoff;
  });
}
