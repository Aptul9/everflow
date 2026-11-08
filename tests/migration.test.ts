import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sqlite, { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { migrate, openDb } from '../src/dispatcher/db.ts';
import { ingest } from '../src/dispatcher/ingest.ts';
import { createV1, OLD_AT, scratch, snapshot } from './support.ts';

const retained = ['cursor', 'conversation', 'person', 'message', 'triage_log'] as const;
// Columns added after v1 start empty on every retained row.
const migrated = (rows: ReturnType<typeof snapshot>) => ({ ...rows, conversation: rows.conversation!.map((row) => ({ ...row, muted_until: null })) });
const dropped = ['draft', 'approval_request', 'approval_event', 'send_attempt', 'work_item', 'work_item_conversation', 'prompt_submission'] as const;
const originalTables = [...retained, 'batch', ...dropped];

afterEach(() => vi.restoreAllMocks());

test('migrates a frozen v1 fixture to schema version 2', async () => {
  const { path } = scratch();
  createV1(path);
  await migrate(path);
  using db = openDb(path);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
});

test('migration deadline covers native waits while backup keeps the source untouched', async ({ task }) => {
  const { path } = scratch('phase2-timing-');
  createV1(path);
  const bytes = readFileSync(path);
  const nativeBackup = sqlite.backup;
  const backup = vi.spyOn(sqlite, 'backup').mockImplementationOnce(async (...args) => {
    const [source] = args;
    const busyTimeout = Number(source.prepare('PRAGMA busy_timeout').get()?.timeout);
    expect(busyTimeout).toBe(30_000);
    // Allow native-I/O headroom above the configured lock-wait budget.
    expect(task.timeout).toBeGreaterThanOrEqual(busyTimeout + 10_000);
    expect(task.timeout).toBeLessThanOrEqual(60_000);
    await setImmediate();
    expect(() => source.exec('PRAGMA user_version = 99')).toThrow(/readonly/i);
    expect(readFileSync(path)).toEqual(bytes);
    expect(source.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(source.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
    return nativeBackup(...args);
  });
  const saved = await migrate(path);
  expect(backup).toHaveBeenCalledOnce();
  expect(saved).toBeTypeOf('string');
  using copy = new DatabaseSync(saved!, { readOnly: true });
  expect(copy.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  expect(copy.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  using db = openDb(path);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('backs up every v1 row before preserving source identities and historical batch references', async () => {
  const { path, root } = scratch();
  createV1(path);
  let rows;
  let batches;
  let allRows;
  {
    using before = new DatabaseSync(path, { readOnly: true });
    rows = snapshot(before, retained);
    batches = before.prepare('SELECT * FROM batch ORDER BY id').all();
    allRows = snapshot(before, originalTables);
  }
  const backup = await migrate(path);
  expect(backup).toBeTypeOf('string');
  expect(backup).not.toBe(path);
  expect(backup?.startsWith(path + '.pre-v2-')).toBe(true);
  expect(existsSync(backup!)).toBe(true);
  using saved = new DatabaseSync(backup!, { readOnly: true });
  expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  expect(saved.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  expect(snapshot(saved, originalTables)).toEqual(allRows);

  {
    using db = openDb(path);
    expect(snapshot(db, retained)).toEqual(migrated(rows));
    expect(db.prepare('SELECT * FROM batch ORDER BY id').all())
      .toEqual(batches.map((batch) => ({ ...batch, outcome: 'historical', ticket: null })));
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_list(batch)').all().map((fk) => fk.table))
      .toEqual(['ticket', 'conversation']);
    for (const name of dropped) {
      expect(db.prepare('SELECT name FROM sqlite_schema WHERE type = ? AND name = ?').get('table', name)).toBeUndefined();
    }
    const childSql = db.prepare("SELECT sql FROM sqlite_schema WHERE name IN ('message','triage_log')").all();
    expect(childSql.every((row) => !String(row.sql).includes('batch_v2'))).toBe(true);
  }
  const backups = readdirSync(root).filter((name) => name.includes('.pre-v2-'));
  expect(await migrate(path)).toBeNull();
  using reopened = openDb(path);
  expect(snapshot(reopened, retained)).toEqual(migrated(rows));
  expect(readdirSync(root).filter((name) => name.includes('.pre-v2-'))).toEqual(backups);
});

test('backs up committed WAL data while the original writer remains open', async () => {
  const { path, root } = scratch();
  createV1(path);
  using writer = new DatabaseSync(path);
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  const main = readFileSync(path);
  writer.prepare('INSERT INTO person(id,email,name) VALUES (?,?,?)').run(92, 'wal@example.invalid', 'Synthetic WAL row');
  expect(existsSync(path + '-wal')).toBe(true);
  expect(readFileSync(path)).toEqual(main);
  const mainOnly = join(root, 'main-without-wal.db');
  writeFileSync(mainOnly, main);
  {
    using withoutWal = new DatabaseSync(mainOnly, { readOnly: true });
    expect(withoutWal.prepare('SELECT COUNT(*) AS n FROM person WHERE id=92').get()?.n).toBe(0);
  }
  const backup = await migrate(path);
  expect(backup).toBeTypeOf('string');
  using saved = new DatabaseSync(backup!, { readOnly: true });
  expect(saved.prepare('SELECT name FROM person WHERE id=92').get()?.name).toBe('Synthetic WAL row');
  expect(saved.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  using db = openDb(path);
  expect(db.prepare('SELECT name FROM person WHERE id=92').get()?.name).toBe('Synthetic WAL row');
});

test('a backup I/O failure changes no source bytes, rows, version or journal mode', async () => {
  const { path } = scratch();
  createV1(path);
  const bytes = readFileSync(path);
  using before = new DatabaseSync(path, { readOnly: true });
  const rows = snapshot(before, originalTables);
  const backup = vi.spyOn(sqlite, 'backup').mockImplementationOnce(async (source) => {
    expect(source.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
    expect(() => source.exec('PRAGMA user_version = 99')).toThrow(/readonly/i);
    throw new Error('synthetic backup I/O denied');
  });
  await expect(migrate(path)).rejects.toThrow('synthetic backup I/O denied');
  expect(backup).toHaveBeenCalledOnce();
  expect(readFileSync(path)).toEqual(bytes);
  expect(snapshot(before, originalTables)).toEqual(rows);
  expect(before.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  expect(before.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
});

test('a late exception rolls back every schema/data change and restores foreign keys before close', async () => {
  const { path } = scratch();
  createV1(path);
  let rows;
  let schema;
  {
    using before = new DatabaseSync(path, { readOnly: true });
    rows = snapshot(before, originalTables);
    schema = before.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
  }
  const exec = DatabaseSync.prototype.exec;
  const dispose = DatabaseSync.prototype[Symbol.dispose];
  const closingFks: unknown[] = [];
  vi.spyOn(DatabaseSync.prototype, Symbol.dispose).mockImplementation(function (this: DatabaseSync) {
    closingFks.push(this.prepare('PRAGMA foreign_keys').get()?.foreign_keys);
    return dispose.call(this);
  });
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.trim() === 'PRAGMA user_version = 2') throw new Error('synthetic late migration exception');
    return exec.call(this, sql);
  });
  await expect(migrate(path)).rejects.toThrow('synthetic late migration exception');
  expect(closingFks.length).toBeGreaterThan(0);
  expect(closingFks.every((fk) => fk === 1)).toBe(true);
  using db = new DatabaseSync(path, { readOnly: true });
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  expect(snapshot(db, originalTables)).toEqual(rows);
  expect(db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all()).toEqual(schema);
  expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
});

test('version 0 scopes legacy keys in two phases and retains native ids, rows and backup originals', async () => {
  const { path } = scratch();
  createV1(path);
  {
    using legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA user_version = 0');
    legacy.prepare('UPDATE message SET message_id = ? WHERE id = 2').run('native-2');
    legacy.prepare('UPDATE message SET message_id = ? WHERE id = 1')
      .run(JSON.stringify(['me@example.invalid', 'native-2']));
  }
  const backup = await migrate(path);
  expect(backup).toBeTypeOf('string');
  using db = openDb(path);
  expect(db.prepare('SELECT message_id,native_id,batch,stored_at FROM message WHERE id=1').get()).toEqual({
    message_id: '["me@example.invalid","native-1"]', native_id: 'native-1', batch: null, stored_at: OLD_AT,
  });
  expect(db.prepare('SELECT message_id FROM message WHERE id=2').get()?.message_id).toBe('["me@example.invalid","native-2"]');
  expect(db.prepare('SELECT id,batch FROM message WHERE id=552').get()).toEqual({ id: 552, batch: 81 });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  using saved = new DatabaseSync(backup!, { readOnly: true });
  expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
  expect(saved.prepare('SELECT message_id FROM message WHERE id=1').get()?.message_id)
    .toBe('["me@example.invalid","native-2"]');
});

test('version 0 without native_id preserves literal legacy ids and account scope', async () => {
  const { path } = scratch();
  createV1(path);
  {
    using legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA user_version = 0; UPDATE message SET message_id = native_id; ALTER TABLE message DROP COLUMN native_id');
  }
  await migrate(path);
  using db = openDb(path);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  expect(db.prepare('SELECT id,message_id,native_id,batch FROM message WHERE id=552').get()).toEqual({
    id: 552, message_id: '["me@example.invalid","native-552"]', native_id: 'native-552', batch: 81,
  });
});

test('version 0 format rollback does not wrap an already scoped identity twice', async () => {
  const { path } = scratch();
  createV1(path);
  let before;
  {
    using legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA user_version = 0');
    before = snapshot(legacy, retained);
  }
  await migrate(path);
  using db = openDb(path);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  expect(snapshot(db, retained)).toEqual(migrated(before));
});

test.each([0, 1])('identical source replay immediately after v%s migration preserves every retained row and historical batch', async (version) => {
  const { path } = scratch('phase8-migration-replay-');
  createV1(path);
  if (version === 0) {
    using legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA user_version=0; UPDATE message SET message_id=native_id; ALTER TABLE message DROP COLUMN native_id');
  }
  const replay = { source: 'teams', account: 'me@example.invalid', conversation_id: 'conversation-41', conversation_title: 'Synthetic 41',
    message_id: 'native-552', sender: 'sender@example.invalid', sender_name: 'Synthetic sender', sender_is_me: false, sent_at: OLD_AT,
    text: 'Synthetic message 552', attachments: [{ name: 'synthetic.txt' }], ref: { synthetic: true } };
  const backup = await migrate(path);
  expect(backup).toBeTypeOf('string');
  const tables = [...retained, 'batch', 'ticket', 'job', 'turn'];
  let before;
  {
    using db = openDb(path);
    before = snapshot(db, tables);
    const changes = db.prepare('SELECT total_changes() AS n').get()!.n;
    expect(ingest(db, replay)).toBe(false);
    expect(snapshot(db, tables)).toEqual(before);
    expect(db.prepare('SELECT total_changes() AS n').get()!.n).toBe(changes);
    expect(db.prepare('SELECT id,native_id,message_id,batch FROM message WHERE id=552').get())
      .toEqual({ id: 552, native_id: 'native-552', message_id: '["me@example.invalid","native-552"]', batch: 81 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }
  using reopened = openDb(path);
  expect(ingest(reopened, replay)).toBe(false);
  expect(snapshot(reopened, tables)).toEqual(before);
  using saved = new DatabaseSync(backup!, { readOnly: true });
  expect(saved.prepare('SELECT id,batch,text FROM draft WHERE id=111').get()).toEqual({ id: 111, batch: 81, text: 'Synthetic draft, never send' });
});

test.each([false, true])('new empty database creates schema without a migration backup (existing file: %s)', async (exists) => {
  const { path, root } = scratch();
  if (exists) writeFileSync(path, '');
  expect(await migrate(path)).toBeNull();
  using db = openDb(path);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  expect(db.prepare('SELECT COUNT(*) AS n FROM health').get()?.n).toBe(0);
  expect(readdirSync(root).some((name) => name.includes('.pre-v2-'))).toBe(false);
});

test('openDb initializes a new database but refuses an old one before touching its journal', () => {
  const fresh = scratch();
  {
    using db = openDb(fresh.path);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
  }
  const legacy = scratch();
  createV1(legacy.path);
  const bytes = readFileSync(legacy.path);
  expect(() => openDb(legacy.path)).toThrow(/migrate/);
  expect(readFileSync(legacy.path)).toEqual(bytes);
});

test('unknown newer versions are refused without a backup or write', async () => {
  const { path, root } = scratch();
  createV1(path);
  {
    using future = new DatabaseSync(path);
    future.exec('PRAGMA user_version = 99');
  }
  const bytes = readFileSync(path);
  await expect(migrate(path)).rejects.toThrow(/99/);
  expect(() => openDb(path)).toThrow(/99/);
  expect(readFileSync(path)).toEqual(bytes);
  expect(readdirSync(root).some((name) => name.includes('.pre-v2-'))).toBe(false);
});

test('late version 0 failure also rolls back native-column creation and every identity rewrite', async () => {
  const { path } = scratch();
  createV1(path);
  let before;
  {
    using legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA user_version=0; UPDATE message SET message_id=native_id; ALTER TABLE message DROP COLUMN native_id');
    before = snapshot(legacy, originalTables);
  }
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.trim() === 'PRAGMA user_version = 2') throw new Error('synthetic identity rollback');
    return exec.call(this, sql);
  });
  await expect(migrate(path)).rejects.toThrow('synthetic identity rollback');
  using db = new DatabaseSync(path, { readOnly: true });
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
  expect(db.prepare('PRAGMA table_info(message)').all().map((column) => column.name)).not.toContain('native_id');
  expect(snapshot(db, originalTables)).toEqual(before);
});

test('version 0 keeps identical native ids distinct across receiving accounts', async () => {
  const { path } = scratch();
  createV1(path);
  {
    using legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA user_version=0');
    legacy.prepare('UPDATE conversation SET account=? WHERE id=2').run('Other@Example.Invalid');
    legacy.prepare('UPDATE message SET native_id=? WHERE id IN (1,2)').run('shared "native" id');
  }
  await migrate(path);
  using db = openDb(path);
  expect(db.prepare('SELECT id,message_id,native_id FROM message WHERE id IN (1,2) ORDER BY id').all()).toEqual([
    { id: 1, message_id: JSON.stringify(['me@example.invalid', 'shared "native" id']), native_id: 'shared "native" id' },
    { id: 2, message_id: JSON.stringify(['other@example.invalid', 'shared "native" id']), native_id: 'shared "native" id' },
  ]);
});

test('invalid retained foreign keys prevent commit without dropping the old schema', async () => {
  const { path } = scratch();
  createV1(path);
  let before;
  {
    using legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA foreign_keys=OFF; UPDATE message SET conversation=999999 WHERE id=1');
    before = snapshot(legacy, originalTables);
  }
  await expect(migrate(path)).rejects.toThrow('Migration foreign key check failed');
  using db = new DatabaseSync(path, { readOnly: true });
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  expect(snapshot(db, originalTables)).toEqual(before);
});
