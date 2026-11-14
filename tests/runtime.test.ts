import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/core/config.ts';
import { openDb, prepareStart } from '../src/core/db.ts';
import { ingest, sourceStart } from '../src/core/ingest.ts';
import * as jobs from '../src/core/jobs.ts';
import { prepareTurn, sync } from '../src/core/chat.ts';
import { isolatedEnvironment } from '../scripts/build.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import { scratch, snapshot } from './support.ts';

// Missing implementation still produces assertion RED, rather than a transform/import failure.
const path = resolve('src/core/runtime.ts');
const runtime: Record<string, any> = existsSync(path) ? await import(pathToFileURL(path).href) : {};
const AT = '2026-11-06T10:00:00.000000Z';
const message = (extra = {}) => ({ source: 'teams', account: 'me@example.invalid', conversation_id: 'synthetic-chat',
  message_id: 'one', sender_is_me: false, sent_at: '2026-11-06T09:00:00Z', text: 'Synthetic source text', attachments: [], ref: {}, ...extra });

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT)); });
afterEach(() => vi.useRealTimers());

function fixture() {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const files = scratch('phase7b-runtime-');
  return { ...files, cfg: loadConfig(files.config) };
}

function owner(db: ReturnType<typeof openDb>, session: string | null = 'synthetic-session') {
  return Number(db.prepare("INSERT INTO ticket(title,lifecycle,session_id,approved_at,created_at) VALUES ('Synthetic','active',?,?,?)")
    .run(session, AT, AT).lastInsertRowid);
}

test('runtime eligibility leaves disabled work durable and never reserves or parks it', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const ticket = owner(db, null);
  jobs.enqueue(db, 'triage', 'disabled-triage', {});
  jobs.enqueue(db, 'start_chat', 'disabled-input', {}, ticket);
  const before = snapshot(db, ['job', 'turn']);
  expect((jobs.claim as any)(db, cfg, 'runtime-disabled', AT, { runtime: true })).toBeNull();
  expect(snapshot(db, ['job', 'turn'])).toEqual(before);
  cfg.tickets.enabled = true;
  const triage = (jobs.claim as any)(db, cfg, 'runtime-triage', AT, { runtime: true });
  expect(triage?.kind).toBe('triage');
  expect((jobs.claim as any)(db, cfg, 'runtime-no-chat', AT, { runtime: true })).toBeNull();
});

test('queued maintenance cannot overtake pending input or form its FIFO barrier', () => {
  const { path, cfg } = fixture();
  cfg.tickets.enabled = cfg.chats.enabled = true;
  using db = openDb(path);
  const ticket = owner(db);
  const maintenance = jobs.enqueue(db, 'sync', 'old-maintenance', {}, ticket);
  const input = jobs.enqueue(db, 'forward', 'pending-input', { batch_ids: [] }, ticket);
  const job = (jobs.claim as any)(db, cfg, 'runtime-fifo', AT, { runtime: true });
  expect(job?.id).toBe(input);
  expect(db.prepare('SELECT state FROM job WHERE id=?').get(maintenance)?.state).toBe('queued');
});

test('successful per-ticket sync completes with the configured due time', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT));
  const { path, cfg } = fixture();
  using db = openDb(path);
  const ticket = owner(db, null);
  jobs.enqueue(db, 'sync', 'per-ticket-sync', {}, ticket);
  const job = jobs.claim(db, cfg, 'sync-run', AT)!;
  await sync(cfg, db, job, { clock: () => AT });
  expect(db.prepare('SELECT state,next_at FROM job WHERE id=?').get(job.id))
    .toMatchObject({ state: 'done', next_at: '2026-11-06T10:05:00.000000Z' });
});

test('chat correction brief carries the exact completed artifact, executable, CLI and config paths', () => {
  const { path, cfg } = fixture(); cfg.tickets.enabled = cfg.chats.enabled = true;
  using db = openDb(path); prepareStart(db, undefined, AT);
  const ticket = owner(db);
  jobs.enqueue(db, 'start_chat', 'staged-correction-brief', {}, ticket);
  const job = jobs.claim(db, cfg, 'staged-brief-run', AT)!;
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const turn = prepareTurn(cfg, db, job, 'brief')!;
  const command = turn.text.split('\n').find((line) => line.startsWith('& '))!;
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  expect(command).toContain(quote(process.execPath));
  expect(command).toContain(quote(join(artifact.root, 'dist/cli.js')));
  expect(command).toContain(`--config ${quote(cfg._config_path)}`);
  expect(command).toContain(`--artifact ${quote(process.env.TEST_BUILD_RECEIPT!)}`);
});

test('reader rejects an invalid message then holds the later complete checkpoint in the same actual child stream', async () => {
  const { path, cfg, root } = fixture();
  using db = openDb(path);
  const floor = sourceStart(db, cfg, 'teams', '2026-11-06T08:00:00Z');
  const records = [{ source: 'teams', accounts: ['me@example.invalid'] }, message({ sender_is_me: 'false' }),
    { source: 'teams', checkpoint: '2026-11-06T09:30:00Z', accounts: ['me@example.invalid'] }];
  const program = join(root, 'synthetic-stream.mjs');
  writeFileSync(program, `process.stdout.write(${JSON.stringify(records.map((record) => JSON.stringify(record)).join('\n') + '\n')});`);
  expect(runtime.readWatcher).toBeTypeOf('function');
  if (!runtime.readWatcher) return;
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const child = spawn(process.execPath, [program], { cwd: artifact.root, env: isolatedEnvironment(artifact.root, process.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await runtime.readWatcher(db, cfg, 'teams', child);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(0);
  expect(db.prepare('SELECT since FROM cursor WHERE source=? ORDER BY account').all('teams').every((row) => row.since === floor)).toBe(true);
  const rejected = db.prepare('SELECT * FROM quarantine ORDER BY id').all();
  expect(rejected).toHaveLength(2);
  expect(rejected[0]?.error).toContain('sender_is_me');
  expect(rejected[1]?.error).toBe('source.blocked-by-quarantine');
  // A new reader observes the durable hold. Restart cannot bypass the rejected row.
  const reader = runtime.createSourceReader(db, cfg, 'teams');
  expect(reader.stdout(Buffer.from(JSON.stringify(message({ message_id: 'later' }))))).toBe(false);
  expect(sourceStart(db, cfg, 'teams', '2026-11-06T11:00:00Z')).toBe(floor);
});

test('stdout and stderr drain independently with source attribution and known-account health', async () => {
  const { path, cfg, root } = fixture();
  using db = openDb(path);
  sourceStart(db, cfg, 'teams', '2026-11-06T08:00:00Z');
  ingest(db, { source: 'teams', accounts: ['me@example.invalid'] });
  const secret = 'synthetic-credential-must-not-appear';
  const program = join(root, 'synthetic-stream.mjs');
  writeFileSync(program, `for(let i=0;i<128;i++) process.stderr.write(${JSON.stringify(secret.repeat(300) + '\n')});
    process.stderr.write(JSON.stringify({source:'teams',code:'teams.scan-incomplete',account:'me@example.invalid',status:401})+'\\n');
    process.stdout.write(${JSON.stringify(JSON.stringify(message()) + '\n')});`);
  expect(runtime.readWatcher).toBeTypeOf('function');
  if (!runtime.readWatcher) return;
  const events: unknown[] = [];
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const child = spawn(process.execPath, [program], { cwd: artifact.root, env: isolatedEnvironment(artifact.root, process.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await runtime.readWatcher(db, cfg, 'teams', child, (event: unknown) => events.push(event));
  expect(db.prepare('SELECT text FROM message').get()?.text).toBe('Synthetic source text');
  expect(db.prepare("SELECT state,last_error FROM health WHERE dependency='teams:me@example.invalid'").get())
    .toMatchObject({ state: 'failing', last_error: 'teams.scan-incomplete (401)' });
  expect(db.prepare("SELECT state FROM health WHERE dependency='teams'").get()?.state).toBe('failing');
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(events.every((event: any) => event.source === 'teams' && typeof event.at === 'string')).toBe(true);
  expect(child.exitCode).toBe(0);
});

test('reader failure observes owned child terminal state before propagating its database error', async () => {
  const { path, cfg, root } = fixture();
  using db = openDb(path); sourceStart(db, cfg, 'teams', '2026-11-06T08:00:00Z');
  db.exec("CREATE TRIGGER ingest_crash BEFORE INSERT ON message BEGIN SELECT RAISE(ABORT,'synthetic ingest failure'); END");
  expect(runtime.readWatcher).toBeTypeOf('function');
  if (!runtime.readWatcher) return;
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT), program = join(root, 'synthetic-failed-reader.mjs');
  writeFileSync(program, `process.stdout.write(${JSON.stringify(JSON.stringify(message()) + '\n')});const timer=setInterval(()=>{},1000);
    process.on('message',value=>{if(value?.type==='everflow.stop')setTimeout(()=>{clearInterval(timer);process.disconnect();},150);});`);
  const child = spawn(process.execPath, [program], { cwd: artifact.root, env: isolatedEnvironment(artifact.root, process.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    await expect(runtime.readWatcher(db, cfg, 'teams', child)).rejects.toThrow('synthetic ingest failure');
    expect(child.exitCode).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(0);
  } finally { child.kill(); await exited; }
});

test.each(['auth.cache-write', 'auth.local-state-json', 'snapshot.bytes-changed', 'dpapi.transform', 'com.attach'])('fixed source diagnostic reason %s survives the runtime boundary', (reason) => {
  const { path, cfg } = fixture(); using db = openDb(path); sourceStart(db, cfg, 'teams', '2026-11-06T08:00:00Z');
  const reader = runtime.createSourceReader(db, cfg, 'teams');
  reader.stderr(Buffer.from(JSON.stringify({ source: 'teams', code: 'teams.scan-incomplete', reason })));
  expect(db.prepare("SELECT last_error FROM health WHERE dependency='teams'").get()?.last_error).toBe(`teams.scan-incomplete: ${reason}`);
});

test.each([
  ['source-mismatch', message({ source: 'outlook' })], ['date', message({ sent_at: '2026-02-30T10:00:00Z' })],
  ['shape', message({ attachments: 'not-an-array' })], ['coverage', { source: 'teams', checkpoint: '2026-11-06T09:00:00Z' }],
])('invalid %s is quarantined without advancing any cursor', (_case, record) => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  sourceStart(db, cfg, 'teams', '2026-11-06T08:00:00Z');
  const before = snapshot(db, ['cursor', 'message']);
  expect(runtime.createSourceReader).toBeTypeOf('function');
  if (!runtime.createSourceReader) return;
  expect(runtime.createSourceReader(db, cfg, 'teams').stdout(Buffer.from(JSON.stringify(record)))).toBe(false);
  expect(snapshot(db, ['cursor', 'message'])).toEqual(before);
  expect(db.prepare('SELECT source,truncated FROM quarantine').get()).toMatchObject({ source: 'teams', truncated: 0 });
});

test('quarantine truncates UTF-8 bytes with a label and replay is fenced by source order and atomic with its cursor', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  sourceStart(db, cfg, 'teams', '2026-11-06T08:00:00Z');
  expect(runtime.createSourceReader).toBeTypeOf('function');
  expect(runtime.replayQuarantine).toBeTypeOf('function');
  if (!runtime.createSourceReader || !runtime.replayQuarantine) return;
  const reader = runtime.createSourceReader(db, cfg, 'teams');
  reader.stdout(Buffer.from('x'.repeat(4095) + 'é' + 'tail'));
  const first = db.prepare('SELECT * FROM quarantine').get()!;
  expect(Buffer.byteLength(String(first.line))).toBe(4095);
  expect(first.truncated).toBe(1);
  expect(String(first.line)).not.toContain('\uFFFD');
  expect(() => runtime.replayQuarantine(db, Number(first.id), AT)).toThrow(/truncated/);
  db.prepare('UPDATE quarantine SET line=?,truncated=0 WHERE id=?').run(JSON.stringify(message()), first.id!);
  reader.stdout(Buffer.from(JSON.stringify({ source: 'teams', checkpoint: '2026-11-06T09:30:00Z', accounts: ['me@example.invalid'] })));
  const checkpoint = Number(db.prepare('SELECT MAX(id) AS id FROM quarantine').get()!.id);
  expect(() => runtime.replayQuarantine(db, checkpoint, AT)).toThrow(/earlier/);
  db.exec("CREATE TRIGGER replay_crash BEFORE UPDATE OF replayed_at ON quarantine BEGIN SELECT RAISE(ABORT,'synthetic replay crash'); END");
  expect(() => runtime.replayQuarantine(db, Number(first.id), AT)).toThrow('synthetic replay crash');
  expect(db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(0);
  expect(db.prepare('SELECT replayed_at FROM quarantine WHERE id=?').get(first.id!)?.replayed_at).toBeNull();
  db.exec('DROP TRIGGER replay_crash');
  expect(runtime.replayQuarantine(db, 'all', AT)).toEqual({ replayed: 2, already: 0 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(1);
  expect(db.prepare("SELECT since FROM cursor WHERE source='teams' AND account='*'").get()?.since).toBe('2026-11-06T09:30:00.000000Z');
  expect(runtime.replayQuarantine(db, Number(first.id), AT)).toEqual({ replayed: 0, already: 1 });
});

test('maintenance uses per-ticket/day keys and due-only rearm without unfinished input', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT));
  const { path, cfg } = fixture();
  using db = openDb(path);
  const ticket = owner(db);
  db.prepare('UPDATE ticket SET session_title=? WHERE id=?').run(`[Working] #${ticket} Synthetic`, ticket);
  expect(runtime.scheduleMaintenance).toBeTypeOf('function');
  if (!runtime.scheduleMaintenance) return;
  runtime.scheduleMaintenance(db, cfg, AT);
  runtime.scheduleMaintenance(db, cfg, AT);
  expect(db.prepare('SELECT key FROM job ORDER BY id').all().map((row) => row.key)).toEqual([
    `sync:ticket:${ticket}:2026-11-06`, `archive:ticket:${ticket}:2026-11-06`, 'purge:ticket:none:2026-11-06',
  ]);
  db.prepare("UPDATE job SET state='done',next_at=?").run('2026-11-06T10:05:00.000000Z');
  runtime.scheduleMaintenance(db, cfg, '2026-11-06T10:04:59Z');
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE state='queued'").get()?.n).toBe(0);
  const input = jobs.enqueue(db, 'forward', 'next-input', { batch_ids: [] }, ticket);
  runtime.scheduleMaintenance(db, cfg, '2026-11-06T10:05:00Z');
  expect(db.prepare("SELECT state FROM job WHERE kind='sync'").get()?.state).toBe('done');
  db.prepare("UPDATE job SET state='done' WHERE id=?").run(input);
  runtime.scheduleMaintenance(db, cfg, '2026-11-06T10:05:00Z');
  expect(db.prepare("SELECT state FROM job WHERE kind='sync'").get()?.state).toBe('queued');
  runtime.scheduleMaintenance(db, cfg, '2026-11-07T10:00:00Z');
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='sync' AND state IN ('queued','running')").get()?.n).toBe(1);
});

test('a rearmed sync starts its backoff over and the interval no longer chases stale titles', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const ticket = owner(db);
  runtime.scheduleMaintenance(db, cfg, AT);
  const sync = () => db.prepare("SELECT state,next_at,failures,attempts,error_class FROM job WHERE kind='sync' AND ticket=?").get(ticket)!;
  // Earlier failures of the day, then a successful run with its next sync a minute out
  db.prepare("UPDATE job SET state='done',next_at=?,failures=9,attempts=2,error_class='dependency',last_error='Transport: fetch failed' WHERE ticket=?").run('2026-11-06T10:01:00.000000Z', ticket);
  // A stage change waits for the retitle worker, not for this interval
  db.prepare("UPDATE ticket SET lifecycle='done',report='done',closed_at=? WHERE id=?").run('2026-11-06T10:00:15.000000Z', ticket);
  runtime.scheduleMaintenance(db, cfg, '2026-11-06T10:00:20Z');
  expect(sync().state).toBe('done');
  runtime.scheduleMaintenance(db, cfg, '2026-11-06T10:01:00Z');
  expect({ ...sync() }).toEqual({ state: 'queued', next_at: '2026-11-06T10:01:00.000000Z', failures: 0, attempts: 0, error_class: null });
});

test('purge changes only old unowned not_on_us text and commits completion under the same lease', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT));
  const { path, cfg } = fixture();
  using db = openDb(path);
  prepareStart(db, undefined, AT);
  for (const [i, outcome] of ['not_on_us', 'backlog', 'proposed', 'not_on_us'].entries()) {
    ingest(db, message({ message_id: `purge-${i}`, conversation_id: `purge-${i}` }));
    const c = db.prepare('SELECT id FROM conversation WHERE native_id=?').get(`purge-${i}`)!.id!;
    const batch = db.prepare("INSERT INTO batch(conversation,state,outcome,created_at) VALUES (?,'done',?,?)").run(c, outcome, AT).lastInsertRowid;
    db.prepare('UPDATE message SET batch=?,stored_at=? WHERE conversation=?').run(batch, i === 3 ? AT : '2026-09-01T00:00:00Z', c);
  }
  const before = snapshot(db, ['message']);
  expect(runtime.runJob).toBeTypeOf('function');
  if (!runtime.runJob) return;
  jobs.enqueue(db, 'purge', 'purge:ticket:none:2026-11-06', {});
  const job = jobs.claim(db, cfg, 'purge-run', AT)!;
  await runtime.runJob(cfg, db, job, { buildReceipt: process.env.TEST_BUILD_RECEIPT, clock: () => AT });
  const after = snapshot(db, ['message']);
  expect(after.message![0]?.text).toBeNull();
  expect(after.message!.slice(1).map((row) => row.text)).toEqual(before.message!.slice(1).map((row) => row.text));
  expect(after.message!.map(({ text: _text, ...row }) => row)).toEqual(before.message!.map(({ text: _text, ...row }) => row));
  expect(db.prepare('SELECT state FROM job WHERE id=?').get(job.id)?.state).toBe('done');
});

test('purge rolls back on a late completion fault, fences the stale owner and commits once after durable reopen', async () => {
  const { path, cfg } = fixture();
  const tables = ['message', 'conversation', 'cursor', 'batch', 'ticket', 'ticket_conversation', 'health'];
  const options = { buildReceipt: process.env.TEST_BUILD_RECEIPT };
  const later = '2026-11-06T10:02:01.000000Z';
  let before: ReturnType<typeof snapshot>, first: jobs.Job;
  {
    using db = openDb(path);
    prepareStart(db, undefined, AT);
    const ticket = owner(db, null);
    for (const i of [0, 1, 2, 3, 4]) {
      ingest(db, message({ message_id: `g9-${i}`, conversation_id: `g9-${i}` }));
      const c = db.prepare('SELECT id FROM conversation WHERE native_id=?').get(`g9-${i}`)!.id!;
      const batch = db.prepare("INSERT INTO batch(conversation,state,outcome,ticket,created_at) VALUES (?,'done',?,?,?)")
        .run(c, i === 4 ? 'backlog' : 'not_on_us', i === 1 ? ticket : null, AT).lastInsertRowid;
      if (i === 2) db.prepare(`INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,?,'primary','you',?)`).run(ticket, c, AT);
      db.prepare('UPDATE message SET batch=?,stored_at=? WHERE conversation=?').run(batch, i === 3 ? AT : '2026-09-01T00:00:00Z', c);
    }
    before = snapshot(db, tables);
    db.exec(`CREATE TRIGGER g9_fault BEFORE UPDATE OF state ON job WHEN NEW.kind='purge' AND NEW.state='done'
      BEGIN SELECT RAISE(ABORT, 'g9 injected completion fault'); END`);
    jobs.enqueue(db, 'purge', 'purge:ticket:none:2026-11-06', {});
    first = jobs.claim(db, cfg, 'g9-first', AT)!;
    await expect(runtime.runJob(cfg, db, first, { ...options, clock: () => AT })).rejects.toThrow('g9 injected completion fault');
    expect(snapshot(db, tables)).toEqual(before);
    expect(db.prepare('SELECT state,run_id FROM job WHERE id=?').get(first.id)).toMatchObject({ state: 'running', run_id: 'g9-first' });
    db.exec('DROP TRIGGER g9_fault');
  }
  {
    using db = openDb(path);
    const fresh = jobs.claim(db, cfg, 'g9-second', later)!;
    expect(fresh.id).toBe(first.id);
    await runtime.runJob(cfg, db, first, { ...options, clock: () => later });
    expect(snapshot(db, tables)).toEqual(before);
    expect(db.prepare('SELECT state,run_id FROM job WHERE id=?').get(first.id)).toMatchObject({ state: 'running', run_id: 'g9-second' });
    await runtime.runJob(cfg, db, fresh, { ...options, clock: () => later });
  }
  using db = openDb(path);
  const after = snapshot(db, tables);
  expect(after.message!.map((row) => row.text)).toEqual([null, ...before.message!.slice(1).map((row) => row.text)]);
  expect(before.message!.slice(1).every((row) => typeof row.text === 'string')).toBe(true);
  expect(after.message!.map(({ text: _text, ...row }) => row)).toEqual(before.message!.map(({ text: _text, ...row }) => row));
  for (const table of ['conversation', 'cursor', 'batch', 'ticket', 'ticket_conversation']) expect(after[table]).toEqual(before[table]);
  const job = db.prepare('SELECT state,run_id,lease_token,next_at FROM job WHERE id=?').get(first.id)!;
  expect(job).toMatchObject({ state: 'done', run_id: null, lease_token: null });
  expect(Date.parse(String(job.next_at))).toBe(Date.parse(later) + 86400_000);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='purge'").get()?.n).toBe(1);
});

test('runtime source argv uses staged Node entries, explicit floors, account inventory and owned Teams destinations', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  sourceStart(db, cfg, 'teams', '2026-11-06T08:00:00Z');
  ingest(db, { source: 'teams', accounts: ['second@example.invalid', 'first@example.invalid'] });
  cfg.sources = { teams: { enabled: true, profile: join(resolve(path, '..'), 'synthetic-profile') } };
  expect(runtime.sourceCommand).toBeTypeOf('function');
  if (!runtime.sourceCommand) return;
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const command = runtime.sourceCommand(cfg, db, 'teams', process.env.TEST_BUILD_RECEIPT, AT);
  expect(command.executable).toBe(process.execPath);
  expect(command.args.slice(0, 2)).toEqual(['--use-system-ca', join(artifact.root, 'dist/watchers/teams.js')]);
  expect(command.args).toContain('--since');
  expect(command.args).toContain('2026-11-06T08:00:00.000000Z');
  expect(command.args.filter((arg: string) => arg === '--expected-account')).toHaveLength(2);
  expect(command.args).not.toContain('--input-type=module');
  expect(command.args).toContain('--cache'); expect(command.args).toContain('--scratch-root');
  expect(command.args[command.args.indexOf('--cache') + 1]).toBe(join(path + '.sources', 'teams-cache.dpapi'));
});

test('heartbeat merges durable store/cutoff metadata and rotating logs never copy diagnostic secrets', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  prepareStart(db, undefined, AT);
  const before = JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()!.detail));
  expect(runtime.heartbeat).toBeTypeOf('function');
  expect(runtime.createLog).toBeTypeOf('function');
  if (!runtime.heartbeat || !runtime.createLog) return;
  runtime.heartbeat(db, { run_id: 'synthetic-run', pid: 123, created: '1234567890', config_path: cfg._config_path, port: 12345 }, AT);
  expect(JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()!.detail))).toMatchObject({ ...before, run_id: 'synthetic-run', pid: 123 });
  cfg.jobs.log_max_bytes = 200; cfg.jobs.log_files = 5;
  const log = runtime.createLog(path, cfg.jobs);
  for (let i = 0; i < 12; i++) log({ at: AT, source: 'teams', code: 'source.stderr-invalid', error: 'synthetic-token-must-not-appear', detail: 'x'.repeat(500) });
  expect(existsSync(path + '.log.4')).toBe(true);
  expect(existsSync(path + '.log.5')).toBe(false);
  expect(readFileSync(path + '.log', 'utf8')).not.toContain('synthetic-token-must-not-appear');
});
