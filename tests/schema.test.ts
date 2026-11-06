import type { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { openDb } from '../src/dispatcher/db.ts';
import { OLD_AT, scratch } from './support.ts';
import { raceChatOpen } from './jobs-support.ts';

function fresh() {
  const db = openDb(scratch().path);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  return db;
}

function ticket(db: DatabaseSync, title = 'Synthetic ticket') {
  return Number(db.prepare('INSERT INTO ticket(title,created_at) VALUES (?,?)').run(title, OLD_AT).lastInsertRowid);
}

function preChatSchema(path: string): void {
  using db = openDb(path);
  const trigger = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='immutable_turn_input'").get()!.sql)
    .replace(',batch_ids', '').replace(' OR NEW.batch_ids IS NOT OLD.batch_ids', '');
  db.exec('DROP TRIGGER immutable_turn_input; ALTER TABLE turn DROP COLUMN batch_ids; ALTER TABLE ticket DROP COLUMN session_title');
  db.exec(trigger);
}

test('chat observation refinement preserves old immutable input and reconstructs its batch ownership', () => {
  const { path } = scratch('phase5-refinement-');
  {
    using db = openDb(path);
    const owner = ticket(db);
    db.exec("INSERT INTO conversation(id,source,account,native_id) VALUES (1,'teams','synthetic@example.invalid','synthetic')");
    db.prepare("INSERT INTO batch(id,conversation,ticket,state,created_at) VALUES (1,1,?,'delivered',?)").run(owner, OLD_AT);
    db.prepare("INSERT INTO turn(ticket,kind,batch,prompt_id,text,session_id,state,created_at) VALUES (?,'forward',1,'msg_legacy','Immutable old input','ses_legacy','admitted',?)").run(owner, OLD_AT);
  }
  preChatSchema(path);
  using refined = openDb(path);
  expect(refined.prepare('SELECT prompt_id,text,session_id,batch_ids FROM turn').get()).toEqual({ prompt_id: 'msg_legacy', text: 'Immutable old input', session_id: 'ses_legacy', batch_ids: '[1]' });
  expect(() => refined.prepare("UPDATE turn SET batch_ids='[]'").run()).toThrow(/immutable/);
  expect(refined.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('concurrent openers recheck chat observation columns inside the acquired writer transaction', async () => {
  const { path } = scratch('phase5-refinement-race-');
  preChatSchema(path);
  expect(await raceChatOpen(path)).toEqual(['ok', 'ok']);
  using db = openDb(path);
  expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
});

test('provides every v2 table and no stored mutable stage', () => {
  using db = fresh();
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name))
    .toEqual(expect.arrayContaining(['ticket', 'ticket_conversation', 'ticket_ref', 'timeline', 'job', 'turn', 'health', 'quarantine']));
  expect(db.prepare('PRAGMA table_info(ticket)').all().map((row) => row.name)).not.toContain('stage');
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('checks lifecycle, report and confidence and retains approval/report/merge fields', () => {
  using db = fresh();
  const id = ticket(db);
  for (const [column, value] of [['lifecycle', 'invented'], ['report', 'invented'], ['confidence', -0.1], ['confidence', 1.1]]) {
    expect(() => db.prepare(`UPDATE ticket SET ${column}=? WHERE id=?`).run(value!, id)).toThrow(/CHECK/);
  }
  expect(db.prepare('PRAGMA table_info(ticket)').all().map((row) => row.name)).toEqual(expect.arrayContaining([
    'summary', 'ask', 'proposal', 'approval_note', 'approved_at', 'closed_at', 'report_at', 'report_message_id',
    'report_turn', 'maybe_ticket', 'merged_into', 'last_activity_at', 'archived_at',
  ]));
  expect(() => db.prepare('UPDATE ticket SET merged_into=? WHERE id=?').run(id, id)).toThrow(/CHECK/);
});

test('one primary or linked route per conversation allows independent context links', () => {
  using db = fresh();
  db.exec("INSERT INTO conversation(id,source,account,native_id) VALUES (1,'teams','me@example.invalid','synthetic')");
  const first = ticket(db);
  const second = ticket(db, 'Second');
  const link = db.prepare('INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,?,?,?,?)');
  link.run(first, 1, 'primary', 'rule', OLD_AT);
  expect(() => link.run(second, 1, 'linked', 'agent', OLD_AT)).toThrow(/UNIQUE/);
  link.run(second, 1, 'context', 'you', OLD_AT);
  expect(() => db.prepare('UPDATE ticket_conversation SET kind=? WHERE ticket=?').run('invalid', second)).toThrow(/CHECK/);
  expect(() => db.prepare('UPDATE ticket_conversation SET "by"=? WHERE ticket=?').run('invalid', second)).toThrow(/CHECK/);
});

test('deduplicates references within a ticket and checks reference enums', () => {
  using db = fresh();
  const first = ticket(db);
  const second = ticket(db, 'Second');
  const ref = db.prepare('INSERT INTO ticket_ref(ticket,kind,key,url,seen_in) VALUES (?,?,?,?,?)');
  ref.run(first, 'jira', 'SYN-1', 'https://example.invalid/SYN-1', 'message');
  expect(() => ref.run(first, 'jira', 'SYN-1', null, 'chat')).toThrow(/UNIQUE/);
  ref.run(second, 'jira', 'SYN-1', null, 'chat');
  expect(() => ref.run(first, 'invalid', 'SYN-2', null, 'chat')).toThrow(/CHECK/);
  expect(() => ref.run(first, 'snow', 'INC1', null, 'invalid')).toThrow(/CHECK/);
});

test('timeline event identity is unique and kind is checked', () => {
  using db = fresh();
  const id = ticket(db);
  const event = db.prepare('INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (?,?,?,?,?,?)');
  event.run(id, OLD_AT, 'comment', 'you', 'Synthetic', 'event-1');
  expect(() => event.run(id, OLD_AT, 'comment', 'you', 'Synthetic', 'event-1')).toThrow(/UNIQUE/);
  expect(() => event.run(id, OLD_AT, 'invalid', 'you', 'Synthetic', 'event-2')).toThrow(/CHECK/);
});

test('jobs have durable enqueue order, unique keys, fenced lease fields and checked policies', () => {
  using db = fresh();
  const insert = db.prepare('INSERT INTO job(kind,key,created_at,updated_at,next_at) VALUES (?,?,?,?,?)');
  const first = insert.run('triage', 'triage:1', OLD_AT, OLD_AT, OLD_AT).lastInsertRowid;
  expect(() => insert.run('collect', 'triage:1', OLD_AT, OLD_AT, OLD_AT)).toThrow(/UNIQUE/);
  expect(() => insert.run('invalid', 'other', OLD_AT, OLD_AT, OLD_AT)).toThrow(/CHECK/);
  expect(() => db.prepare('UPDATE job SET state=? WHERE id=?').run('invalid', first)).toThrow(/CHECK/);
  expect(() => db.prepare('UPDATE job SET error_class=? WHERE id=?').run('invalid', first)).toThrow(/CHECK/);
  expect(() => db.prepare('UPDATE job SET failures=-1 WHERE id=?').run(first)).toThrow(/CHECK/);
  expect(() => db.prepare('UPDATE job SET attempts=-1 WHERE id=?').run(first)).toThrow(/CHECK/);
  for (const kind of ['sync', 'archive', 'purge']) {
    const id = insert.run(kind, kind, OLD_AT, OLD_AT, OLD_AT).lastInsertRowid;
    expect(() => db.prepare("UPDATE job SET state='parked' WHERE id=?").run(id)).toThrow(/CHECK/);
  }
  const last = insert.run('forward', 'last', OLD_AT, OLD_AT, OLD_AT).lastInsertRowid;
  db.prepare('DELETE FROM job WHERE id=?').run(last);
  expect(Number(insert.run('forward', 'later', OLD_AT, OLD_AT, OLD_AT).lastInsertRowid)).toBeGreaterThan(Number(last));
  expect(db.prepare('PRAGMA table_info(job)').all().map((row) => row.name))
    .toEqual(expect.arrayContaining(['failures', 'lease_token', 'run_id', 'lease_until']));
});

test('turns keep one immutable prompt target/text and durable context/recovery/reservation fields', () => {
  using db = fresh();
  const id = ticket(db);
  const insert = db.prepare('INSERT INTO turn(ticket,kind,prompt_id,text,session_id,created_at) VALUES (?,?,?,?,?,?)');
  const turn = insert.run(id, 'brief', 'prompt-1', 'Synthetic immutable input', 'session-1', OLD_AT).lastInsertRowid;
  expect(() => insert.run(id, 'forward', 'prompt-1', 'Changed', 'session-1', OLD_AT)).toThrow(/UNIQUE/);
  expect(() => insert.run(id, 'invalid', 'prompt-2', 'Changed', 'session-1', OLD_AT)).toThrow(/CHECK/);
  expect(() => db.prepare('UPDATE turn SET state=? WHERE id=?').run('invalid', turn)).toThrow(/CHECK/);
  expect(() => db.prepare('UPDATE turn SET outcome=? WHERE id=?').run('invalid', turn)).toThrow(/CHECK/);
  for (const [column, value] of [['text', 'changed'], ['session_id', 'other'], ['prompt_id', 'other']]) {
    expect(() => db.prepare(`UPDATE turn SET ${column}=? WHERE id=?`).run(value!, turn)).toThrow(/immutable/);
  }
  expect(db.prepare('PRAGMA table_info(turn)').all().map((row) => row.name))
    .toEqual(expect.arrayContaining(['recovery_of', 'input_turn', 'recovery_count', 'context_ids', 'reserved_at', 'admitted_at']));
});

test('quarantine preserves at most 4096 UTF-8 bytes with explicit replay/truncation fields', () => {
  using db = fresh();
  const insert = db.prepare('INSERT INTO quarantine(source,line,error,at,truncated) VALUES (?,?,?,?,?)');
  insert.run('teams', 'x'.repeat(4096), 'synthetic invalid line', OLD_AT, 0);
  expect(() => insert.run('teams', 'é'.repeat(2049), 'too long', OLD_AT, 1)).toThrow(/CHECK/);
  expect(() => insert.run('teams', 'x', 'bad flag', OLD_AT, 2)).toThrow(/CHECK/);
  expect(db.prepare('SELECT replayed_at FROM quarantine').get()?.replayed_at).toBeNull();
});
