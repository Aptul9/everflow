import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { loadConfig } from '../src/core/config.ts';
import { migrate, openDb, prepareStart } from '../src/core/db.ts';
import { createV1, scratch } from './support.ts';

test('explicit scratch config drives migration/start/reopen without enabling work', async () => {
  expect(typeof document).toBe('undefined');
  const fixture = scratch();
  createV1(fixture.path);
  writeFileSync(fixture.config, `[db]\npath = "fixture.db"\n[start]\ntriage_after = "2026-11-05T20:00:00Z"\n`);
  const cfg = loadConfig(fixture.config);
  const saved = await migrate(cfg.db.path);
  expect(saved).toBeTypeOf('string');
  expect(readFileSync(saved!).length).toBeGreaterThan(0);
  {
    using db = openDb(cfg.db.path);
    expect(prepareStart(db, cfg.start.triage_after)).toBe('2026-11-05T20:00:00.000000Z');
  }
  using db = openDb(cfg.db.path);
  expect(prepareStart(db)).toBe('2026-11-05T20:00:00.000000Z');
  expect(db.prepare("SELECT COUNT(*) AS n FROM batch WHERE outcome='backlog'").get()?.n).toBe(73);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE batch IS NULL').get()?.n).toBe(0);
  for (const table of ['ticket', 'job', 'turn']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
  expect(cfg.tickets.enabled).toBe(false);
  expect(cfg.chats.enabled).toBe(false);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
