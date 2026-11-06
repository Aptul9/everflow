import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/dispatcher/config.ts';
import { openDb, prepareStart } from '../src/dispatcher/db.ts';
import { claim, complete, enqueue, park } from '../src/dispatcher/jobs.ts';
import { scheduleMaintenance, startRuntime } from '../src/dispatcher/runtime.ts';
import { startChat } from '../src/dispatcher/chat.ts';
import { connect } from '../src/dispatcher/opencode.ts';
import * as native from '../src/windows/kernel.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import { trackSourceChild } from '../src/watchers/source.ts';
import { scratch } from './support.ts';
import { remoteSession, scriptedPeer } from './opencode-support.ts';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const f = scratch('phase7b-review-safe-');
  return { ...f, cfg: loadConfig(f.config) };
}
function ticket(db: ReturnType<typeof openDb>, name: string) {
  const at = new Date().toISOString();
  return Number(db.prepare("INSERT INTO ticket(title,lifecycle,approved_at,created_at) VALUES (?,'active',?,?)").run(name, at, at).lastInsertRowid);
}

test('I1 queued reserved pre-turn work reconciles before independent fresh input', async () => {
  const f = fixture(); f.cfg.tickets.enabled = f.cfg.chats.enabled = true;
  using db = openDb(f.path); prepareStart(db);
  const old = enqueue(db, 'start_chat', 'old-reservation', {}, ticket(db, 'Old'));
  db.prepare('UPDATE job SET reserved_at=? WHERE id=?').run(new Date().toISOString(), old);
  const fresh = enqueue(db, 'start_chat', 'fresh-input', {}, ticket(db, 'Fresh'));
  const calls: number[] = [];
  const handler = (_cfg: unknown, connection: ReturnType<typeof openDb>, job: any) => { calls.push(job.id); complete(connection, job, () => {}); };
  const runtime = await startRuntime(f.cfg, db, { buildReceipt: process.env.TEST_BUILD_RECEIPT!, runId: 'safe-review-run', handlers: { start_chat: handler } });
  try { await delay(40); expect(calls).toEqual([old, fresh]); }
  finally { await runtime.close(); }
});

test('I1 old parked reservation blocks its ticket and holds one slot without freezing independent capacity', async () => {
  const f = fixture(); f.cfg.tickets.enabled = f.cfg.chats.enabled = true; f.cfg.jobs.turn_concurrency = 2;
  using db = openDb(f.path); prepareStart(db);
  const blockedTicket = ticket(db, 'Parked');
  const old = enqueue(db, 'start_chat', 'parked-reservation', {}, blockedTicket);
  db.prepare('UPDATE job SET reserved_at=? WHERE id=?').run(new Date().toISOString(), old);
  park(db, old, 'Explicit manual retry required');
  const tail = enqueue(db, 'forward', 'same-ticket-tail', { batch_ids: [] }, blockedTicket);
  const fresh = enqueue(db, 'start_chat', 'independent-input', {}, ticket(db, 'Independent'));
  const calls: number[] = [];
  const handler = (_cfg: unknown, connection: ReturnType<typeof openDb>, job: any) => { calls.push(job.id); complete(connection, job, () => {}); };
  const runtime = await startRuntime(f.cfg, db, { buildReceipt: process.env.TEST_BUILD_RECEIPT!, runId: 'parked-review-run', handlers: { start_chat: handler, forward: handler } });
  try {
    await delay(40); expect(calls).toEqual([fresh]);
    expect(db.prepare('SELECT state,reserved_at FROM job WHERE id=?').get(old)).toMatchObject({ state: 'parked', reserved_at: expect.any(String) });
    expect(db.prepare('SELECT state FROM job WHERE id=?').get(tail)?.state).toBe('queued');
  } finally { await runtime.close(); }
});

test('I1 chats-off old pre-turn reservation looks up and persists an accepted tag without create or prompt', async () => {
  const f = fixture(); f.cfg.tickets.enabled = true; f.cfg.chats.enabled = false;
  await using peer = await scriptedPeer(); f.cfg.opencode.url = peer.url;
  using db = openDb(f.path); prepareStart(db);
  const owner = ticket(db, 'Accepted old create');
  const store = JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()!.detail)).store_id;
  peer.sessions.set('ses_accepted', remoteSession('ses_accepted', f.cfg.opencode.directory, { inbox_dispatcher: { store_id: store, ticket: owner } }));
  const id = enqueue(db, 'start_chat', 'old-create-lookup', {}, owner);
  const job = claim(db, f.cfg, 'old-create-run')!;
  await startChat(f.cfg, db, job, { peer: connect(f.cfg) });
  expect(peer.calls.filter((call) => call.method === 'GET' && call.url.pathname === '/api/session')).toHaveLength(2);
  expect(peer.calls.some((call) => call.method !== 'GET')).toBe(false);
  expect(db.prepare('SELECT session_id FROM ticket WHERE id=?').get(owner)?.session_id).toBe('ses_accepted');
  expect(db.prepare('SELECT state,reserved_at,turn_id FROM job WHERE id=?').get(id)).toMatchObject({ state: 'queued', reserved_at: job.reserved_at, turn_id: null });
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
});

test.each(['sync', 'archive'] as const)('M1 prior-day completed %s due time survives a new day key', (kind) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T23:59:00Z'));
  const f = fixture(); using db = openDb(f.path); prepareStart(db);
  const owner = ticket(db, 'Maintenance'); db.prepare("UPDATE ticket SET session_id='synthetic-session' WHERE id=?").run(owner);
  const old = enqueue(db, kind, `${kind}:ticket:${owner}:2026-11-06`, {}, owner);
  db.prepare("UPDATE job SET state='done',next_at='2026-11-07T00:04:00.000000Z' WHERE id=?").run(old);
  vi.setSystemTime(new Date('2026-11-07T00:00:00Z')); scheduleMaintenance(db, f.cfg);
  expect(db.prepare("SELECT id FROM job WHERE kind=? AND ticket=? AND state='queued'").all(kind, owner)).toEqual([]);
  vi.setSystemTime(new Date('2026-11-07T00:04:00Z')); scheduleMaintenance(db, f.cfg); scheduleMaintenance(db, f.cfg);
  expect(db.prepare("SELECT key FROM job WHERE kind=? AND ticket=? AND state='queued'").all(kind, owner))
    .toEqual([{ key: `${kind}:ticket:${owner}:2026-11-07` }]);
});

function fakeWatcher() {
  const child: any = new EventEmitter();
  Object.assign(child, { pid: 1000000101, stdout: new PassThrough(), stderr: new PassThrough(), connected: true, exitCode: null, signalCode: null });
  child.send = (value: any, callback?: () => void) => {
    callback?.(); if (value.type !== 'dispatcher.stop') return;
    child.connected = false; child.exitCode = 0; child.stdout.end(); child.stderr.end(); queueMicrotask(() => child.emit('close', 0));
  };
  child.kill = () => { child.send({ type: 'dispatcher.stop' }); return true; };
  return child as ChildProcess;
}
const watcherIdentity = { pid: 1000000101, created: '134384000000000001', image: 'C:\\synthetic\\node.exe' };
const original = { pid: 1000000202, created: '134384000000000002', image: 'C:\\synthetic\\ssh.exe' };
const replacement = { ...original, created: '134384000000000099', image: 'C:\\unrelated\\node.exe' };

async function ownershipFixture() {
  const f = fixture(); f.cfg.sources = { teams: { enabled: true, entrypoint: 'tests/inert-watcher.ts', profile: join(f.root, 'never-read-profile') } };
  const db = openDb(f.path); prepareStart(db);
  const child = fakeWatcher(), terminated: unknown[] = [];
  let current = original;
  const kernel: any = {
    processIdentity: vi.fn((pid: number) => pid === process.pid ? { pid, created: '134384000000000000', image: 'C:\\synthetic\\node.exe' } : pid === watcherIdentity.pid ? watcherIdentity : current),
    processes: vi.fn(() => [{ pid: original.pid, parent: watcherIdentity.pid, exe: 'ssh.exe' }]),
    childOf: vi.fn((identity: any, owner: any) => identity.created === current.created && identity.image === current.image && owner.created === watcherIdentity.created),
    running: vi.fn((identity: any) => identity.created === current.created),
    terminate: vi.fn((identity: any) => { terminated.push(identity); return true; }),
    [Symbol.dispose]: () => {},
  };
  vi.spyOn(native, 'createKernel').mockReturnValue(kernel);
  const runtime = await startRuntime(f.cfg, db, { buildReceipt: process.env.TEST_BUILD_RECEIPT!, runId: 'injected-ownership-run',
    spawnWatcher: () => { queueMicrotask(() => child.emit('spawn')); return child; },
  });
  return { ...f, db, child, runtime, kernel, terminated, setCurrent: (identity: typeof original) => { current = identity; } };
}

test('I2 injected snapshot-to-identity PID reuse never enrolls or terminates the unrelated replacement', async () => {
  const f = await ownershipFixture();
  let owned: unknown[] = [];
  try {
    f.kernel.processes.mockImplementation(() => { f.setCurrent(replacement); return [{ pid: original.pid, parent: watcherIdentity.pid, exe: 'ssh.exe' }]; });
    f.setCurrent(replacement);
    f.child.emit('message', { type: 'dispatcher.child', pid: original.pid, active: true, identity: original, owner: watcherIdentity });
    owned = f.runtime.children();
  } finally { await f.runtime.close(); f.db.close(); }
  expect(owned).not.toEqual(expect.arrayContaining([expect.objectContaining({ pid: replacement.pid, created: replacement.created })]));
  expect(f.terminated).not.toEqual(expect.arrayContaining([expect.objectContaining({ created: replacement.created })]));
});

test('I2 stale inactive packet cannot unregister a newer verified owned child with the same injected PID', async () => {
  const f = await ownershipFixture();
  try {
    f.child.emit('message', { type: 'dispatcher.child', pid: original.pid, active: true, identity: original, owner: watcherIdentity });
    const newer = { ...original, created: '134384000000000003' }; f.setCurrent(newer);
    f.child.emit('message', { type: 'dispatcher.child', pid: newer.pid, active: true, identity: newer, owner: watcherIdentity });
    f.child.emit('message', { type: 'dispatcher.child', pid: original.pid, active: false, identity: original, owner: watcherIdentity });
    expect(f.runtime.children()).toEqual(expect.arrayContaining([expect.objectContaining({ pid: newer.pid, created: newer.created })]));
  } finally { await f.runtime.close(); f.db.close(); }
});

test('I2 source captures identity inside spawn ownership and reuses that exact identity for inactive IPC', async () => {
  fixture(); const child = fakeWatcher(), events: any[] = [];
  const capture = vi.fn(() => ({ ...original, pid: child.pid! }));
  (trackSourceChild as any)(child, { owner: watcherIdentity, capture, send: (value: unknown) => events.push(value) });
  child.emit('spawn'); await delay(0);
  capture.mockReturnValue({ ...replacement, pid: child.pid! });
  Object.assign(child, { exitCode: 0, connected: false }); child.emit('close', 0); await delay(0);
  expect(events).toHaveLength(2);
  expect(events.map((value) => value.identity.created)).toEqual([original.created, original.created]);
  expect(events.every((value) => value.owner.created === watcherIdentity.created)).toBe(true);
  expect(capture).toHaveBeenCalledTimes(1);
});

test('I2 native ancestry is queried on the expected-instance handle and mismatched creation never reaches parent lookup', () => {
  fixture(); let created = original.created;
  const parentLookup = vi.fn((handle: bigint, _kind: number, bytes: Buffer, _length: number, needed: number[]) => {
    expect(handle).toBe(40n); bytes.writeBigUInt64LE(BigInt(original.pid), 32); bytes.writeBigUInt64LE(BigInt(watcherIdentity.pid), 40); needed[0] = 48; return 0;
  });
  const api = {
    OpenProcess: (_access: number, inherit: number, pid: number) => { expect(inherit).toBe(0); return pid === original.pid ? 40n : 41n; },
    GetLastError: () => 0, CloseHandle: () => 1, WaitForSingleObject: () => 258,
    GetProcessTimes: (handle: bigint, bytes: Buffer) => { bytes.writeBigUInt64LE(BigInt(handle === 40n ? created : watcherIdentity.created)); return 1; },
    QueryFullProcessImageNameW: (handle: bigint, _flags: number, bytes: Buffer, length: number[]) => { const image = handle === 40n ? original.image : watcherIdentity.image; bytes.write(image, 'utf16le'); length[0] = image.length; return 1; },
    NtQueryInformationProcess: parentLookup,
  };
  using kernel = native.createKernel(api);
  expect((kernel as any).childOf).toBeTypeOf('function');
  if (!(kernel as any).childOf) return;
  expect((kernel as any).childOf(original, watcherIdentity)).toBe(true);
  expect(parentLookup).toHaveBeenCalledTimes(1);
  created = replacement.created;
  expect((kernel as any).childOf(original, watcherIdentity)).toBe(false);
  expect(parentLookup).toHaveBeenCalledTimes(1);
  expect(kernel.resources.size).toBe(0);
});

test('runtime callback failure records fixed stage/OS operation without arbitrary exception text', async () => {
  const f = fixture(); using db = openDb(f.path); prepareStart(db);
  const errors: unknown[] = [];
  const runtime = await startRuntime(f.cfg, db, { buildReceipt: process.env.TEST_BUILD_RECEIPT!, runId: 'safe-diagnostic-run',
    onHeartbeat: () => { throw Object.assign(new Error('synthetic-secret-must-not-be-logged'), { code: 'EACCES', syscall: 'rename' }); }, onError: (error) => errors.push(error),
  });
  try {
    const log = fs.readFileSync(f.path + '.log', 'utf8');
    expect(log).not.toContain('synthetic-secret-must-not-be-logged');
    expect(log.split('\n').filter(Boolean).map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ code: 'runtime.failed', stage: 'heartbeat.receipt', reason: 'EACCES', operation: 'rename' }));
    expect(errors).toHaveLength(1);
  } finally { await runtime.close(); }
});
