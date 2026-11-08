import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCRATCH = 'C:/Users/Antonio/AppData/Local/Temp/opencode/workdesk';
export const OLD_AT = '2026-11-04T17:01:02.123456Z';
export const CUTOFF = '2026-11-05T20:00:00.000Z';

export function scratch(prefix = 'phase1-') {
  mkdirSync(SCRATCH, { recursive: true });
  const root = mkdtempSync(join(SCRATCH, prefix));
  const path = join(root, 'fixture.db');
  const config = join(root, 'config.toml');
  writeFileSync(config, '[db]\npath = "fixture.db"\n');
  return { root, path, config };
}

export function createV1(path: string): void {
  using db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./fixtures/v1.sql', import.meta.url), 'utf8'));
  db.exec('PRAGMA user_version = 1; BEGIN IMMEDIATE');
  db.prepare('INSERT INTO cursor VALUES (?, ?, ?)').run('teams', 'me@example.invalid', OLD_AT);
  db.prepare('INSERT INTO person VALUES (?, ?, ?, ?, ?)')
    .run(91, 'sender@example.invalid', 'synthetic-oid', null, 'Synthetic sender');
  const conversation = db.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let id = 1; id <= 73; id++) {
    conversation.run(id, 'teams', 'Me@Example.Invalid', `conversation-${id}`, `Synthetic ${id}`, 'approve', OLD_AT);
  }
  db.prepare('INSERT INTO work_item(id, title, session_id, created_at, last_activity_at) VALUES (?,?,?,?,?)')
    .run(51, 'Synthetic old work', 'old-session-must-not-resume', OLD_AT, OLD_AT);
  db.prepare('INSERT INTO batch VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(81, 1, 51, 'delivered', 'old-prompt', 'old error', OLD_AT, OLD_AT, null);
  const message = db.prepare(`INSERT INTO message
    (id,source,message_id,native_id,conversation,person,sender,sender_name,sender_is_me,
     sent_at,text,attachments,ref,batch,stored_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let id = 1; id <= 552; id++) {
    message.run(id, 'teams', JSON.stringify(['me@example.invalid', `native-${id}`]), `native-${id}`,
      (id - 1) % 73 + 1, 91, 'sender@example.invalid', 'Synthetic sender', 0, OLD_AT,
      `Synthetic message ${id}`, '[{"name":"synthetic.txt"}]', '{"synthetic":true}', id === 552 ? 81 : null, OLD_AT);
  }
  db.prepare('INSERT INTO work_item_conversation VALUES (?,?,?,?)').run(51, 1, 'attach', OLD_AT);
  db.prepare('INSERT INTO triage_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(101, 81, 1, OLD_AT, 1, 1, 'new', '51 historical text', 'synthetic reason', 0.9, '[51]', '{"synthetic":true}');
  db.prepare('INSERT INTO draft VALUES (?,?,?,?,?,?,?,?,?)')
    .run(111, 51, 1, 81, 'Synthetic draft, never send', 'pending', 'old-draft-key', OLD_AT, OLD_AT);
  db.prepare('INSERT INTO approval_request VALUES (?,?,?,?,?,?)')
    .run(111, 'synthetic', 'target', 'fingerprint', 'anchor', OLD_AT);
  db.prepare('INSERT INTO approval_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(121, 111, 'synthetic', 'target', 'event', 'approve', 'Synthetic body', 'fingerprint', 'done', OLD_AT, 81, null);
  db.prepare('INSERT INTO send_attempt VALUES (?,?,?,?,?,?)')
    .run(111, 'old-draft-key', 'pending', null, null, OLD_AT);
  db.prepare('INSERT INTO prompt_submission VALUES (?,?,?,?,?,?,?)')
    .run(81, 'old-session-must-not-resume', 'old-prompt', 'Synthetic prompt', 'accepted', OLD_AT, null);
  db.exec('COMMIT');
}

export function snapshot(db: DatabaseSync, tables: readonly string[]) {
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
}
