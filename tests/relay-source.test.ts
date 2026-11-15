import fs from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { createRelayState, readRelay, relayCommand, scanRelay, shellQuote, sqlLiteral, sshQuery } from '../src/watchers/relay.ts';
import type { RelayOptions, RelayQuery, SshSpawn } from '../src/watchers/relay.ts';
import { safeSourceDiagnostic } from '../src/watchers/source.ts';
import type { SourceMessage, SourceRecord } from '../src/watchers/source.ts';
import { migrate, openDb } from '../src/core/db.ts';
import { ingest, sourceStart } from '../src/core/ingest.ts';
import { scratch, snapshot } from './support.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import * as native from '../src/windows/kernel.ts';

const since = '2026-11-04T10:00:00.000Z';
const mid = String(Date.parse('2026-11-04T10:02:00.000Z'));
const owner = `owner';SELECT '$(unchanged)';--@example.invalid`;
const options: RelayOptions = { host: 'synthetic-host', root: `/synthetic relay';$(unchanged)/data`, owner };

function relayFixture() {
  const { root } = scratch('phase7-relay-');
  const appPath = join(root, 'app.db');
  using app = new DatabaseSync(appPath);
  app.exec('CREATE TABLE "user"(id TEXT,email TEXT); CREATE TABLE teams_accounts(slot INTEGER,owner_id TEXT,stopped INTEGER);');
  app.prepare('INSERT INTO "user" VALUES (?,?)').run('mine', owner);
  app.prepare('INSERT INTO "user" VALUES (?,?)').run('other', 'other@example.invalid');
  app.exec("INSERT INTO teams_accounts VALUES(1,'mine',0),(2,'other',0),(3,'mine',1)");
  fs.mkdirSync(join(root, '1'));
  const storePath = join(root, '1', 'messages.db');
  using store = new DatabaseSync(storePath);
  store.exec('CREATE TABLE state(k TEXT,v TEXT); CREATE TABLE chat_messages(chat TEXT,idx INTEGER,mid TEXT,author TEXT,text TEXT,mine INTEGER,extra TEXT); CREATE TABLE chats(name TEXT PRIMARY KEY,muted INTEGER DEFAULT 0);');
  store.prepare('INSERT INTO state VALUES (?,?)').run('me', JSON.stringify({ email: 'ME@Example.Invalid' }));
  store.prepare('INSERT INTO state VALUES (?,?)').run('last_scan_ts', String(Date.parse(since) / 1000 + 600));
  for (let i = 0; i < 9; i++) store.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?,?,?)').run(`Saved chat ${i}`, i, String(Number(mid) + i), 'Bob', `Saved ${i}`, 0, '{}');
  const queries: { path: string; sql: string }[] = [];
  const query: RelayQuery = async (path, sql) => {
    queries.push({ path, sql });
    const local = path === posix.join(options.root, 'app.db') ? appPath : path === posix.join(options.root, '1/messages.db') ? storePath : join(root, 'missing.db');
    using db = new DatabaseSync(local, { readOnly: true, allowExtension: false });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;');
    try { return db.prepare(sql).all(); } finally { db.exec('ROLLBACK'); }
  };
  return { root, appPath, storePath, query, queries };
}

test('every remote argument is shell quoted and SQL literals preserve hostile quotes, semicolons and substitution', () => {
  expect(shellQuote("a'b;$(x)")).toBe("'a'\"'\"'b;$(x)'");
  expect(sqlLiteral(owner)).toBe(`'${owner.replaceAll("'", "''")}'`);
  const sql = `SELECT ${sqlLiteral(owner)};`;
  expect(relayCommand(posix.join(options.root, 'app.db'), sql)).toBe(['sqlite3', '-readonly', '-json', posix.join(options.root, 'app.db'), `PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN; ${sql} COMMIT;`].map(shellQuote).join(' '));
});

test('owner-scoped active numeric slots read all saved chats inside one readonly saved-store query; no commands table', async () => {
  const fixture = relayFixture();
  const snapshot = await readRelay(options, Date.parse(since), undefined, fixture.query);
  expect(snapshot.errors).toEqual([]);
  expect(snapshot.accounts).toHaveLength(1);
  expect(snapshot.accounts[0]).toMatchObject({ slot: 1, email: 'me@example.invalid' });
  expect(snapshot.accounts[0]!.messages).toHaveLength(9);
  expect(fixture.queries.map((q) => q.path)).toEqual([posix.join(options.root, 'app.db'), posix.join(options.root, '1/messages.db')]);
  using db = new DatabaseSync(fixture.storePath, { readOnly: true });
  expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='commands'").get()!.n).toBe(0);
});

test('missing database cannot be created or checkpointed', async () => {
  const { root } = scratch('phase7-relay-missing-');
  const missing = join(root, 'app.db');
  const query: RelayQuery = async (_path, sql) => {
    using db = new DatabaseSync(missing, { readOnly: true });
    return db.prepare(sql).all();
  };
  await expect(readRelay(options, Date.parse(since), undefined, query)).rejects.toThrow(/relay.app-unavailable/);
  expect(fs.existsSync(missing)).toBe(false);
});

test('non-numeric slot cannot become an SSH path or claim completed coverage', async () => {
  const query = vi.fn(async () => [{ slot: '../unsafe' }]);
  await expect(readRelay(options, Date.parse(since), undefined, query)).rejects.toThrow(/relay.invalid-slot/);
  expect(query).toHaveBeenCalledOnce();
});

test('inaccessible saved store is an attributed error rather than empty success', async () => {
  const query: RelayQuery = async (_path, sql) => {
    if (sql.includes('teams_accounts')) return [{ slot: 7 }];
    throw new Error('synthetic unavailable store');
  };
  const snapshot = await readRelay(options, Date.parse(since), undefined, query);
  expect(snapshot.errors).toMatchObject([{ code: 'relay.store-unavailable', account: 'slot:7' }]);
  const rows: SourceRecord[] = [];
  await expect(scanRelay({ snapshot: async () => snapshot }, createRelayState(since), (row) => { rows.push(row); })).rejects.toThrow(/relay.scan-incomplete/);
  expect(rows.some((row) => 'checkpoint' in row)).toBe(false);
});

test('bounded saved results fail explicitly instead of claiming truncated completion', async () => {
  const fixture = relayFixture();
  const snapshot = await readRelay({ ...options, maxRows: 2 }, Date.parse(since), undefined, fixture.query);
  expect(snapshot.errors).toMatchObject([{ code: 'relay.result-limit', account: 'slot:1' }]);
  expect(snapshot.accounts).toEqual([]);
  const error = await scanRelay({ snapshot: async () => snapshot }, createRelayState(since), () => {}).catch((failure: unknown) => failure);
  expect(safeSourceDiagnostic(error, 'teamsrelay')).toMatchObject({ code: 'relay.scan-incomplete', reason: 'relay.result-limit', account: 'slot:1' });
});

test('numeric mid epochms, saved text cap, quote/files/ref and deletion markers survive normalization', async () => {
  const fixture = relayFixture();
  {
    using db = new DatabaseSync(fixture.storePath);
    db.prepare('UPDATE chat_messages SET text=?,mine=?,extra=? WHERE idx=0').run('x'.repeat(2500), 1, JSON.stringify({ files: [{ name: 'fixture.txt' }], quote: { author: 'Alice', text: 'Quoted body' } }));
    db.prepare('UPDATE chat_messages SET extra=? WHERE idx=1').run(JSON.stringify({ deletetime: '2026-11-04T10:05:00Z' }));
    db.prepare('INSERT INTO chat_messages VALUES(?,?,?,?,?,?,?)').run('Invalid numeric suffix', 99, mid + 'x', 'Bob', 'ignored', 0, '{}');
  }
  const snapshot = await readRelay(options, Date.parse(since), undefined, fixture.query);
  expect(snapshot.errors).toEqual([]);
  expect(snapshot.accounts[0]!.messages).toHaveLength(9);
  const first = snapshot.accounts[0]!.messages[0]!;
  expect(first).toMatchObject({ sender_is_me: true, sent_at: new Date(Number(mid)).toISOString(), attachments: [{ name: 'fixture.txt', size: null }], ref: { relay_slot: 1, id: mid, account: 'me@example.invalid' } });
  expect(first.text).toBe('> in reply to Alice: Quoted body\n' + 'x'.repeat(2000));
  expect(snapshot.accounts[0]!.messages[1]).toMatchObject({ text: '', attachments: [], ref: { deleted: true } });
});

test('chats muted in Teams and mentions of the account owner are read from the saved store', async () => {
  const fixture = relayFixture();
  {
    using db = new DatabaseSync(fixture.storePath);
    db.exec("INSERT INTO chats VALUES ('Saved chat 0',1),('Saved chat 1',0)");
    db.prepare('UPDATE chat_messages SET extra=? WHERE idx=2').run(JSON.stringify({ mentionsMe: true }));
  }
  const snapshot = await readRelay(options, Date.parse(since), undefined, fixture.query);
  expect(snapshot.accounts[0]!.muted).toEqual(['Saved chat 0']);
  expect(snapshot.accounts[0]!.messages[2]!.ref).toMatchObject({ mentions_me: true });
  expect(snapshot.accounts[0]!.messages[3]!.ref).not.toHaveProperty('mentions_me');

  const relay = { snapshot: (floor: number) => readRelay(options, floor, undefined, fixture.query) };
  const state = createRelayState(since);
  const rows: SourceRecord[] = [];
  const emit = (row: SourceRecord) => { rows.push(row); };
  const mutes = () => rows.filter((row) => 'muted' in row);
  await scanRelay(relay, state, emit);
  expect(mutes()).toEqual([{ source: 'teamsrelay', account: 'me@example.invalid', muted: ['Saved chat 0'] }]);
  expect(rows.findIndex((row) => 'muted' in row)).toBeLessThan(rows.findIndex((row) => 'message_id' in row));
  await scanRelay(relay, state, emit);
  expect(mutes()).toHaveLength(1);
  { using db = new DatabaseSync(fixture.storePath); db.exec("UPDATE chats SET muted=0"); }
  await scanRelay(relay, state, emit);
  expect(mutes().at(-1)).toEqual({ source: 'teamsrelay', account: 'me@example.invalid', muted: [] });
});

test('late body save survives restart after list scan; fixed replay floor never advances from observed_at', async () => {
  const fixture = relayFixture();
  { using db = new DatabaseSync(fixture.storePath); db.exec('DELETE FROM chat_messages'); }
  using db = openDb(':memory:');
  sourceStart(db, { start: { lookback_minutes: 0 } }, 'teamsrelay', since);
  const relay = { snapshot: (floor: number) => readRelay(options, floor, undefined, fixture.query) };
  const emit = (row: SourceRecord) => { ingest(db, row); };
  await scanRelay(relay, createRelayState(since), emit, () => '2026-11-04T11:00:00.000Z');
  const resumed = sourceStart(db, { start: { lookback_minutes: 0 } }, 'teamsrelay', '2026-11-04T12:00:00Z');
  { using store = new DatabaseSync(fixture.storePath); store.prepare('INSERT INTO chat_messages VALUES(?,?,?,?,?,?,?)').run('Late body', 0, mid, 'Bob', 'Saved after list scan', 0, '{}'); }
  const state = createRelayState(resumed);
  await scanRelay(relay, state, emit, () => '2026-11-04T12:00:00.000Z');
  await scanRelay(relay, createRelayState(resumed), emit, () => '2026-11-04T13:00:00.000Z');
  expect(db.prepare('SELECT COUNT(*) AS n FROM message').get()!.n).toBe(1);
  expect(sourceStart(db, { start: { lookback_minutes: 0 } }, 'teamsrelay')).toBe('2026-11-04T10:00:00.000000Z');
  expect(state.floor).toBe(Date.parse(since));
});

test('known saved-message edit and deletion emit again in the same process', async () => {
  const fixture = relayFixture();
  const relay = { snapshot: (floor: number) => readRelay(options, floor, undefined, fixture.query) };
  const state = createRelayState(since);
  const rows: SourceRecord[] = [];
  const emit = (row: SourceRecord) => { rows.push(row); };
  await scanRelay(relay, state, emit);
  await scanRelay(relay, state, emit);
  { using db = new DatabaseSync(fixture.storePath); db.prepare('UPDATE chat_messages SET text=? WHERE idx=0').run('Edited'); }
  await scanRelay(relay, state, emit);
  { using db = new DatabaseSync(fixture.storePath); db.prepare('UPDATE chat_messages SET extra=? WHERE idx=0').run('{"deleted":true}'); }
  await scanRelay(relay, state, emit);
  expect(rows.filter((row): row is SourceMessage => 'message_id' in row && row.ref.id === mid).map((row) => row.text)).toEqual(['Saved 0', 'Edited', '']);
});

test.each([false, true])('exact v1 relay native identity replays against migrated history without requeue or double scope (native column absent: %s)', async (withoutNative) => {
  const fixture = relayFixture(), path = join(fixture.root, 'migration-fixture.db');
  { using saved = new DatabaseSync(fixture.storePath); saved.exec('DELETE FROM chat_messages WHERE idx<>0'); }
  const relay = { snapshot: (floor: number) => readRelay(options, floor, undefined, fixture.query) };
  const record = (await relay.snapshot(Date.parse(since))).accounts[0]!.messages[0]!;
  const native = `me@example.invalid/Saved chat 0;messageid=${mid}`;
  expect(record.message_id).toBe(native);
  {
    using legacy = new DatabaseSync(path);
    legacy.exec(fs.readFileSync(new URL('./fixtures/v1.sql', import.meta.url), 'utf8'));
    legacy.exec('PRAGMA user_version=0');
    legacy.prepare('INSERT INTO conversation(id,source,account,native_id,title,last_message_at) VALUES (7,?,?,?,?,?)')
      .run('teamsrelay', 'me@example.invalid', 'Saved chat 0', 'Saved chat 0', record.sent_at);
    legacy.prepare("INSERT INTO batch(id,conversation,state,created_at) VALUES (18,7,'done',?)").run(since);
    legacy.prepare(`INSERT INTO message(id,source,message_id,native_id,conversation,sender,sender_name,sender_is_me,sent_at,text,attachments,ref,batch,stored_at)
      VALUES (29,'teamsrelay',?,?,7,'bob','Bob',0,?,?,?,?,18,?)`)
      .run(native, native, record.sent_at, record.text!, JSON.stringify(record.attachments), JSON.stringify(record.ref), since);
    for (const account of ['*', 'me@example.invalid']) legacy.prepare("INSERT INTO cursor VALUES ('teamsrelay',?,?)").run(account, since);
    if (withoutNative) legacy.exec('ALTER TABLE message DROP COLUMN native_id');
  }
  const backup = await migrate(path);
  expect(backup).toBeTypeOf('string');
  const tables = ['cursor', 'conversation', 'person', 'message', 'batch', 'ticket', 'job', 'turn'];
  let before;
  for (let round = 0; round < 2; round++) {
    using db = openDb(path);
    before ??= snapshot(db, tables);
    const replayed: boolean[] = [];
    await scanRelay(relay, createRelayState(sourceStart(db, { start: { lookback_minutes: 0 } }, 'teamsrelay')), (row) => {
      const changed = ingest(db, row); if ('message_id' in row) replayed.push(changed);
    });
    expect(replayed).toEqual([false]);
    expect(snapshot(db, tables)).toEqual(before);
    expect(db.prepare('SELECT id,native_id,message_id,batch FROM message').get())
      .toEqual({ id: 29, native_id: native, message_id: JSON.stringify(['me@example.invalid', native]), batch: 18 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }
});

test('saved relay text cap preserves2000 Unicode characters already returned by SQLite substr', async () => {
  const fixture = relayFixture();
  { using db = new DatabaseSync(fixture.storePath); db.prepare('UPDATE chat_messages SET text=? WHERE idx=0').run('\u{10400}'.repeat(2001)); }
  const result = await readRelay(options, Date.parse(since), undefined, fixture.query);
  expect(Array.from(result.accounts[0]!.messages[0]!.text!)).toHaveLength(2000);
});

test('SSH transport has fixed noninteractive argv and rejects option-like host before spawn', async () => {
  const childFactory = vi.fn((..._args: any[]) => spawn(process.execPath, ['-e', 'process.stdout.write("[]")'], { windowsHide: true }));
  await expect(sshQuery(options, '/synthetic/db', 'SELECT 1;', undefined, childFactory)).resolves.toEqual([]);
  const args = childFactory.mock.calls[0]!;
  expect(args[0]).toBe('ssh');
  expect(args[1]).toEqual(expect.arrayContaining(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'synthetic-host']));
  expect(args[2]).toMatchObject({ shell: false, windowsHide: true });
  childFactory.mockClear();
  await expect(sshQuery({ ...options, host: '-oProxyCommand=bad' }, '/synthetic/db', 'SELECT 1;', undefined, childFactory)).rejects.toThrow(/relay.invalid-host/);
  expect(childFactory).not.toHaveBeenCalled();
});

test.each(['abort', 'timeout', 'overflow'])('SSH %s closes owned child and all timer/listener state before rejecting', async (mode) => {
  const controller = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  const childFactory = ((..._args: any[]) => {
    child = spawn(process.execPath, ['-e', mode === 'overflow' ? 'process.stdout.write("x".repeat(20000));setInterval(()=>{},1000)' : 'setInterval(()=>{},1000)'], { windowsHide: true });
    if (mode === 'abort') queueMicrotask(() => controller.abort());
    return child;
  }) as SshSpawn;
  await expect(sshQuery({ ...options, timeoutMs: 200, maxBytes: 1000 }, '/synthetic/db', 'SELECT 1;', controller.signal, childFactory)).rejects.toThrow(/relay.(aborted|timeout|result-limit)/);
  expect(child).toBeDefined();
  expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
});

test.each(['owner-capture', 'owner-dispose', 'child-capture', 'child-dispose', 'owner-capture-sync-close', 'child-notification'])('owner setup tracking failure stops and observes its owned child before rejecting (%s)', async (mode) => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT); const files = scratch('phase7b-owner-setup-');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const connected = Object.getOwnPropertyDescriptor(process, 'connected'), send = Object.getOwnPropertyDescriptor(process, 'send');
  const originalOwner = process.env.EVERFLOW_SOURCE_OWNER;
  Object.defineProperty(process, 'connected', { value: true, configurable: true, writable: true });
  const notify = vi.fn((_value: unknown, callback?: (error?: Error) => void) => { callback?.(); });
  Object.defineProperty(process, 'send', { value: notify, configurable: true, writable: true });
  process.env.EVERFLOW_SOURCE_OWNER = String(process.ppid);
  const controller = new AbortController(), child: any = new EventEmitter();
  let spawned = 0, kills = 0, closed = false, kernels = 0;
  const controls: Record<string, unknown>[] = [];
  const close = () => { if (closed) return; closed = true; child.signalCode = 'SIGTERM'; child.stdout.end('discarded trailing output'); child.stderr.end('discarded trailing stderr'); child.emit('close', null); };
  Object.assign(child, { pid: 1000000101, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    kill() { kills++; if (mode.endsWith('sync-close')) close(); else setImmediate(close); return true; },
  });
  const failure = mode === 'child-notification' ? Object.assign(new Error('synthetic IPC notification failure'), { code: 'ERR_IPC_CHANNEL_CLOSED' })
    : new native.NativeError(mode.endsWith('dispose') ? 'native.cleanup' : 'native.process-open', 5);
  if (mode === 'child-notification') notify.mockImplementation((_value, callback) => { callback?.(failure); });
  const kernel = vi.spyOn(native, 'createKernel').mockImplementation(() => {
    const phase = ++kernels;
    return {
      processIdentity: (pid: number) => {
        controls.push({ close: child.listenerCount('close'), error: child.listenerCount('error'), stdout: child.stdout.listenerCount('data'), stderr: child.stderr.listenerCount('data'), abort: getEventListeners(controller.signal, 'abort').length, timers: vi.getTimerCount() });
        if (mode.startsWith('owner-capture') && phase === 1 || mode === 'child-capture' && phase === 2) throw failure;
        return { pid, created: String(134384000000000000n + BigInt(phase)), image: resolve('/synthetic/node.exe') };
      },
      [Symbol.dispose]: () => { if (mode === 'owner-dispose' && phase === 1 || mode === 'child-dispose' && phase === 2) throw failure; },
    } as unknown as ReturnType<typeof native.createKernel>;
  });
  let rejected: unknown, snapshot: Record<string, unknown> | undefined;
  try {
    try {
      await sshQuery({ ...options, timeoutMs: 5000 }, '/synthetic/fixture.db', 'SELECT 1', controller.signal, () => {
        spawned++; queueMicrotask(() => child.emit('spawn'));
        setImmediate(() => setImmediate(() => {
          if (closed) return;
          closed = true; child.exitCode = 0; child.stdout.end('[]'); child.stderr.end(); child.emit('close', 0);
        }));
        return child;
      });
    } catch (error) { rejected = error; }
    snapshot = { spawned, kills, closed, abort: getEventListeners(controller.signal, 'abort').length, timers: vi.getTimerCount(),
      stdoutBuffered: child.stdout.readableLength, stderrBuffered: child.stderr.readableLength,
      listeners: { error: child.listenerCount('error'), close: child.listenerCount('close'), spawn: child.listenerCount('spawn'), stdout: child.stdout.listenerCount('data'), stderr: child.stderr.listenerCount('data') } };
    expect(rejected).toBe(failure); expect(snapshot).toMatchObject({ spawned: 1, kills: expect.any(Number), closed: true, abort: 0, timers: 0 }); expect(kills).toBeGreaterThan(0);
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((state) => Number(state.close) > 0 && Number(state.error) > 0 && Number(state.stdout) > 0 && Number(state.stderr) > 0 && state.abort === 1 && Number(state.timers) > 0)).toBe(true);
    expect(child.listenerCount('error')).toBe(0); expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('spawn')).toBe(0); expect(kernels).toBe(mode.startsWith('child-') ? 2 : 1);
    expect(child.stdout.listenerCount('data')).toBe(0); expect(child.stderr.listenerCount('data')).toBe(0);
    expect(child.stdout.readableLength).toBe(0); expect(child.stderr.readableLength).toBe(0);
  } finally {
    if (!closed) { const exit = new Promise<void>((resolve) => child.once('close', () => resolve())); child.kill(); await exit; }
    child.stdout.destroy(); child.stderr.destroy(); kernel.mockRestore();
    if (connected) Object.defineProperty(process, 'connected', connected); else delete (process as any).connected;
    if (send) Object.defineProperty(process, 'send', send); else delete (process as any).send;
    if (originalOwner === undefined) delete process.env.EVERFLOW_SOURCE_OWNER; else process.env.EVERFLOW_SOURCE_OWNER = originalOwner;
    fs.writeFileSync(join(files.root, 'proof.json'), JSON.stringify({ config: files.config, artifact: process.env.TEST_BUILD_RECEIPT, mode, observedAtQuerySettlement: snapshot, controls, finalClosed: closed, finalTimers: vi.getTimerCount() }, null, 2));
    vi.useRealTimers();
  }
});
