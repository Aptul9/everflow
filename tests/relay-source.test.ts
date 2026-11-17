import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { createRelayState, httpRelaySaved, readRelay, relayMain, scanRelay } from '../src/watchers/relay.ts';
import type { RelayOptions, RelaySaved } from '../src/watchers/relay.ts';
import { safeSourceDiagnostic } from '../src/watchers/source.ts';
import type { SourceMessage, SourceRecord } from '../src/watchers/source.ts';
import { migrate, openDb } from '../src/core/db.ts';
import { ingest, sourceStart } from '../src/core/ingest.ts';
import { scratch, snapshot } from './support.ts';

const since = '2026-11-04T10:00:00.000Z';
const mid = String(Date.parse('2026-11-04T10:02:00.000Z'));
const options: RelayOptions = {};
const TOKEN = 'everflow-token-0123456789abcdef0123456789';

// The query the Teams relay runs for Everflow on each slot store (OE-Copilot teams-relay/app/src/lib/everflow-saved.ts), copied
// here so the records below come from real SQLite stores as they did over SSH.
const STORE_QUERY = `SELECT json_object('state',json((SELECT json_group_object(k,v) FROM state WHERE k IN ('me','last_scan_ts','state'))),'muted',json((SELECT json_group_array(name) FROM chats WHERE muted=1)),'messages',json((SELECT json_group_array(json_object('chat',chat,'mid',mid,'author',author,'text',text,'mine',mine,'extra',extra)) FROM (SELECT chat,mid,author,substr(text,1,2000) AS text,mine,extra FROM chat_messages WHERE mid GLOB '[0-9]*' AND mid NOT GLOB '*[^0-9]*' AND CAST(mid AS INTEGER)>=? ORDER BY CAST(mid AS INTEGER),chat LIMIT ?)))) AS snapshot`;

function relayFixture() {
  const { root } = scratch('phase7-relay-');
  const appPath = join(root, 'app.db');
  using app = new DatabaseSync(appPath);
  app.exec('CREATE TABLE "user"(id TEXT,email TEXT); CREATE TABLE teams_accounts(slot INTEGER,owner_id TEXT,stopped INTEGER);');
  app.prepare('INSERT INTO "user" VALUES (?,?)').run('mine', 'owner@example.invalid');
  app.prepare('INSERT INTO "user" VALUES (?,?)').run('other', 'other@example.invalid');
  app.exec("INSERT INTO teams_accounts VALUES(1,'mine',0),(2,'other',0),(3,'mine',1)");
  fs.mkdirSync(join(root, '1'));
  const storePath = join(root, '1', 'messages.db');
  using store = new DatabaseSync(storePath);
  store.exec('CREATE TABLE state(k TEXT,v TEXT); CREATE TABLE chat_messages(chat TEXT,idx INTEGER,mid TEXT,author TEXT,text TEXT,mine INTEGER,extra TEXT); CREATE TABLE chats(name TEXT PRIMARY KEY,muted INTEGER DEFAULT 0);');
  store.prepare('INSERT INTO state VALUES (?,?)').run('me', JSON.stringify({ email: 'ME@Example.Invalid' }));
  store.prepare('INSERT INTO state VALUES (?,?)').run('last_scan_ts', String(Date.parse(since) / 1000 + 600));
  for (let i = 0; i < 9; i++) store.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?,?,?)').run(`Saved chat ${i}`, i, String(Number(mid) + i), 'Bob', `Saved ${i}`, 0, '{}');
  const calls: { floor: number; maxRows: number }[] = [];
  const saved: RelaySaved = async (floor, maxRows) => {
    calls.push({ floor, maxRows });
    using appDb = new DatabaseSync(appPath, { readOnly: true });
    const slots = appDb.prepare("SELECT slot FROM teams_accounts WHERE owner_id='mine' AND stopped=0 ORDER BY slot LIMIT 1025").all().map((row) => Number(row.slot));
    return slots.map((slot) => {
      const file = join(root, String(slot), 'messages.db');
      if (!fs.existsSync(file)) return { slot, error: 'store-unavailable' };
      using db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      return { slot, snapshot: String(db.prepare(STORE_QUERY).get(floor, maxRows + 1)!.snapshot) };
    });
  };
  return { root, appPath, storePath, saved, calls };
}

async function endpoint(answer: (url: URL) => { status: number; body: string }) {
  const seen: { url: string; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization });
    const { status, body } = answer(new URL(req.url!, 'http://x'));
    res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

test("the owner's active numeric slots read all saved chats in one call; no commands table", async () => {
  const fixture = relayFixture();
  const snapshot = await readRelay(options, Date.parse(since), undefined, fixture.saved);
  expect(snapshot.errors).toEqual([]);
  expect(snapshot.accounts).toHaveLength(1);
  expect(snapshot.accounts[0]).toMatchObject({ slot: 1, email: 'me@example.invalid' });
  expect(snapshot.accounts[0]!.messages).toHaveLength(9);
  expect(fixture.calls).toEqual([{ floor: Date.parse(since), maxRows: 10000 }]);
  using db = new DatabaseSync(fixture.storePath, { readOnly: true });
  expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='commands'").get()!.n).toBe(0);
});

test('httpRelaySaved asks /everflow/teams since the floor for max_rows and hands back the slots', async () => {
  const fixture = relayFixture();
  const answers = await fixture.saved(Date.parse(since), 10000);
  const live = await endpoint(() => ({ status: 200, body: JSON.stringify({ slots: answers }) }));
  try {
    const snapshot = await readRelay(options, Date.parse(since), undefined, httpRelaySaved({ url: live.url, token: TOKEN }));
    expect(snapshot.accounts[0]!.messages).toHaveLength(9);
    expect(live.seen).toEqual([{ url: `/everflow/teams?since=${Date.parse(since)}&max_rows=10000`, auth: `Bearer ${TOKEN}` }]);
  } finally { live.close(); }
});

test('endpoint 502 or 401 is relay.http-failed, JSON of the wrong shape relay.saved-shape, not JSON relay.response-json; no checkpoint either way', async () => {
  for (const [answer, code, status] of [[{ status: 502, body: '{"error":"teams relay unreachable"}' }, 'relay.http-failed', 502], [{ status: 401, body: '' }, 'relay.http-failed', 401],
    [{ status: 200, body: '{"slots":{}}' }, 'relay.saved-shape', undefined], [{ status: 200, body: '<html>' }, 'relay.response-json', undefined]] as const) {
    const oe = await endpoint(() => answer);
    try {
      const relay = { snapshot: (floor: number) => readRelay(options, floor, undefined, httpRelaySaved({ url: oe.url, token: TOKEN })) };
      const rows: SourceRecord[] = [];
      await expect(scanRelay(relay, createRelayState(since), (row) => { rows.push(row); })).rejects.toMatchObject({ code, status });
      expect(rows).toEqual([]);
    } finally { oe.close(); }
  }
});

test('the relay watcher takes the endpoint from its environment and no longer knows --host, --data-dir or --owner', async () => {
  const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    vi.stubEnv('EVERFLOW_OE_URL', 'https://teams.example/communication'); vi.stubEnv('EVERFLOW_OE_TOKEN', '');
    await expect(relayMain(['--since', since, '--once'])).rejects.toMatchObject({ code: 'relay.oe-config' });
    for (const extra of [['--host', 'oe-vm'], ['--data-dir', '/srv'], ['--owner', 'o@example.invalid']]) await expect(relayMain(['--since', since, '--once', ...extra])).rejects.toThrow();
  } finally { errors.mockRestore(); vi.unstubAllEnvs(); }
});

test('no active slot is relay.no-active-accounts, more than maxAccounts is relay.account-limit', async () => {
  await expect(readRelay(options, Date.parse(since), undefined, async () => [])).rejects.toThrow(/relay.no-active-accounts/);
  await expect(readRelay({ maxAccounts: 1 }, Date.parse(since), undefined, async () => [{ slot: 1, snapshot: '{}' }, { slot: 2, snapshot: '{}' }])).rejects.toThrow(/relay.account-limit/);
});

test('non-numeric or repeated slot cannot claim completed coverage', async () => {
  const saved = vi.fn(async () => [{ slot: '../unsafe' as unknown as number, snapshot: '{}' }]);
  await expect(readRelay(options, Date.parse(since), undefined, saved)).rejects.toThrow(/relay.invalid-slot/);
  expect(saved).toHaveBeenCalledOnce();
  await expect(readRelay(options, Date.parse(since), undefined, async () => [{ slot: 1, snapshot: '{}' }, { slot: 1, snapshot: '{}' }])).rejects.toThrow(/relay.invalid-slot/);
});

test('slot error is store-unavailable attributed to the slot, rather than empty success', async () => {
  const fixture = relayFixture();
  fs.rmSync(fixture.storePath);
  expect((await readRelay(options, Date.parse(since), undefined, fixture.saved)).errors).toEqual([{ code: 'relay.store-unavailable', account: 'slot:1' }]);
  const snapshot = await readRelay(options, Date.parse(since), undefined, async () => [{ slot: 7, error: 'store-unavailable' }]);
  expect(snapshot.errors).toMatchObject([{ code: 'relay.store-unavailable', account: 'slot:7' }]);
  const rows: SourceRecord[] = [];
  await expect(scanRelay({ snapshot: async () => snapshot }, createRelayState(since), (row) => { rows.push(row); })).rejects.toThrow(/relay.scan-incomplete/);
  expect(rows.some((row) => 'checkpoint' in row)).toBe(false);
});

test('bounded saved results fail explicitly instead of claiming truncated completion', async () => {
  const fixture = relayFixture();
  const snapshot = await readRelay({ ...options, maxRows: 2 }, Date.parse(since), undefined, fixture.saved);
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
  const snapshot = await readRelay(options, Date.parse(since), undefined, fixture.saved);
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
  const snapshot = await readRelay(options, Date.parse(since), undefined, fixture.saved);
  expect(snapshot.accounts[0]!.muted).toEqual(['Saved chat 0']);
  expect(snapshot.accounts[0]!.messages[2]!.ref).toMatchObject({ mentions_me: true });
  expect(snapshot.accounts[0]!.messages[3]!.ref).not.toHaveProperty('mentions_me');

  const relay = { snapshot: (floor: number) => readRelay(options, floor, undefined, fixture.saved) };
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
  const relay = { snapshot: (floor: number) => readRelay(options, floor, undefined, fixture.saved) };
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
  const relay = { snapshot: (floor: number) => readRelay(options, floor, undefined, fixture.saved) };
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
  const relay = { snapshot: (floor: number) => readRelay(options, floor, undefined, fixture.saved) };
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
  const result = await readRelay(options, Date.parse(since), undefined, fixture.saved);
  expect(Array.from(result.accounts[0]!.messages[0]!.text!)).toHaveLength(2000);
});
