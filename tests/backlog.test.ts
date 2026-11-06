import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { migrate, openDb, prepareStart } from '../src/dispatcher/db.ts';
import { CUTOFF, createV1, OLD_AT, scratch, snapshot } from './support.ts';

const CUT = '2026-11-05T20:00:00.000000Z';
const START = '2026-11-06T00:00:00.000000Z';

test('551 old ingestions in 73 conversations become 73 backlog batches and no tickets or jobs', async () => {
  const { path } = scratch();
  createV1(path);
  await migrate(path);
  using db = openDb(path);
  const before = snapshot(db, ['cursor', 'conversation', 'person', 'triage_log']);
  const messages = db.prepare('SELECT * FROM message ORDER BY id').all();
  const oldBatch = db.prepare('SELECT * FROM batch WHERE id=81').get();
  expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE batch IS NULL').get()?.n).toBe(551);
  expect(prepareStart(db, CUTOFF, START)).toBe(CUT);
  expect(db.prepare("SELECT COUNT(*) AS n FROM batch WHERE outcome='backlog'").get()?.n).toBe(73);
  expect(db.prepare("SELECT COUNT(DISTINCT conversation) AS n FROM batch WHERE outcome='backlog'").get()?.n).toBe(73);
  expect(db.prepare("SELECT COUNT(*) AS n FROM message JOIN batch ON batch.id=message.batch WHERE batch.outcome='backlog'").get()?.n).toBe(551);
  for (const table of ['ticket', 'job', 'turn']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
  expect(snapshot(db, ['cursor', 'conversation', 'person', 'triage_log'])).toEqual(before);
  expect(db.prepare('SELECT * FROM batch WHERE id=81').get()).toEqual(oldBatch);
  const withoutBatch = (rows: typeof messages) => rows.map(({ batch: _batch, ...row }) => row);
  expect(withoutBatch(db.prepare('SELECT * FROM message ORDER BY id').all())).toEqual(withoutBatch(messages));
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('cutoff uses ingested time, strict inequality, timezone offsets and original microsecond precision', async () => {
  const { path } = scratch();
  createV1(path);
  await migrate(path);
  using db = openDb(path);
  const insert = db.prepare(`INSERT INTO message(id,source,message_id,native_id,conversation,sender_is_me,sent_at,text,stored_at)
    VALUES (?,'teams',?,?,1,0,?,'Synthetic boundary',?)`);
  for (const [id, stored] of [
    [600, '2026-11-05T20:00:00Z'],
    [601, '2026-11-05T22:00:00.000000+02:00'],
    [602, '2026-11-05T21:00:00.000000Z'],
    [603, '2026-11-05T20:00:00.000001Z'],
    [604, '2026-11-05T19:59:59.999999Z'],
    [605, '2026-11-05T21:59:59.999999+02:00'],
  ] as const) insert.run(id, `edge-${id}`, `edge-${id}`, OLD_AT, stored);
  expect(prepareStart(db, CUTOFF, START)).toBe(CUT);
  expect(db.prepare('SELECT id FROM message WHERE id>=600 AND batch IS NULL ORDER BY id').all())
    .toEqual([{ id: 600 }, { id: 601 }, { id: 602 }, { id: 603 }]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM message JOIN batch ON batch.id=message.batch WHERE batch.outcome='backlog'").get()?.n).toBe(553);
  expect(db.prepare('SELECT stored_at FROM message WHERE id=605').get()?.stored_at).toBe('2026-11-05T21:59:59.999999+02:00');
});

test('connect/migrate do not resolve cutoff or consume pending source messages', async () => {
  const { path } = scratch();
  createV1(path);
  await migrate(path);
  using db = openDb(path);
  expect(db.prepare('SELECT COUNT(*) AS n FROM health').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE batch IS NULL').get()?.n).toBe(551);
  expect(db.prepare("SELECT COUNT(*) AS n FROM batch WHERE outcome='backlog'").get()?.n).toBe(0);
});

test('explicit cutoff is stored once and survives restart and later overrides', async () => {
  const { path } = scratch();
  createV1(path);
  await migrate(path);
  const explicit = '2026-11-01T00:00:00.123456Z';
  let detail;
  {
    using db = openDb(path);
    expect(prepareStart(db, explicit, START)).toBe(explicit);
    detail = db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()?.detail;
    expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE batch IS NULL').get()?.n).toBe(551);
  }
  using reopened = openDb(path);
  expect(prepareStart(reopened, CUTOFF, '2026-11-07T00:00:00Z')).toBe(explicit);
  expect(reopened.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()?.detail).toBe(detail);
  expect(reopened.prepare('SELECT COUNT(*) AS n FROM message WHERE batch IS NULL').get()?.n).toBe(551);
});

test('default first-start cutoff and durable store identity survive restart of an empty instance', () => {
  const { path } = scratch();
  let detail: Record<string, unknown>;
  {
    using db = openDb(path);
    expect(prepareStart(db, undefined, START)).toBe(START);
    detail = JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()?.detail));
    expect(detail.store_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(detail.first_started_at).toBe(START);
  }
  using reopened = openDb(path);
  expect(prepareStart(reopened, undefined, '2026-11-08T00:00:00Z')).toBe(START);
  expect(JSON.parse(String(reopened.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()?.detail))).toEqual(detail!);
});

test('preexisting daemon run metadata and store id are retained when resolving first cutoff', () => {
  using db = openDb(scratch().path);
  const detail = { store_id: 'synthetic-store', run_id: 'synthetic-run', pid: 123, custom: { retained: true } };
  db.prepare('INSERT INTO health(dependency,state,since,last_error,detail) VALUES (?,?,?,?,?)')
    .run('daemon', 'retrying', OLD_AT, 'synthetic restart', JSON.stringify(detail));
  expect(prepareStart(db, CUTOFF, START)).toBe(CUT);
  const saved = JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()?.detail));
  expect(saved).toEqual({ ...detail, triage_after: CUT, first_started_at: START });
  db.prepare("UPDATE health SET last_ok=?,state='ok',last_error=NULL WHERE dependency='daemon'").run('2026-11-06T00:00:10.000000Z');
  expect(JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()?.detail))).toEqual(saved);
});

test('first cutoff and all backlog assignments roll back together on a message write failure', async () => {
  const { path } = scratch();
  createV1(path);
  await migrate(path);
  using db = openDb(path);
  const before = snapshot(db, ['message', 'batch', 'health']);
  db.exec(`CREATE TRIGGER reject_backlog BEFORE UPDATE OF batch ON message WHEN OLD.id=2
    BEGIN SELECT RAISE(ABORT, 'synthetic backlog write failure'); END`);
  expect(() => prepareStart(db, CUTOFF, START)).toThrow('synthetic backlog write failure');
  expect(snapshot(db, ['message', 'batch', 'health'])).toEqual(before);
  db.exec('DROP TRIGGER reject_backlog');
  expect(prepareStart(db, CUTOFF, START)).toBe(CUT);
  expect(db.prepare("SELECT COUNT(*) AS n FROM batch WHERE outcome='backlog'").get()?.n).toBe(73);
});

test('first-start default uses current UTC once and does not resolve an old schema', () => {
  using db = openDb(scratch().path);
  const before = Date.now();
  const cutoff = prepareStart(db);
  expect(Date.parse(cutoff)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(cutoff)).toBeLessThanOrEqual(Date.now());
  expect(cutoff).toMatch(/\.\d{6}Z$/);
  const { path } = scratch();
  createV1(path);
  using legacy = new DatabaseSync(path);
  expect(() => prepareStart(legacy, CUTOFF, START)).toThrow(/version 2/);
});
