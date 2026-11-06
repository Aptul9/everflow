import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { isolatedEnvironment } from '../scripts/build.ts';
import { openDb } from '../src/dispatcher/db.ts';
import { createKernel } from '../src/windows/kernel.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import { http } from './web-support.ts';
import { createV1, scratch } from './support.ts';

function fixture() {
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const files = scratch('phase7b-cli ');
  writeFileSync(files.config, `[db]\npath="fixture.db"\n[tickets]\nenabled=false\n[chats]\nenabled=false\n[web]\nport=18789\n[sources.outlook]\nenabled=false\n[sources.teams]\nenabled=false\n[sources.teamsrelay]\nenabled=false\n`);
  const cli = join(artifact.root, 'dist/cli.js');
  const env = isolatedEnvironment(artifact.root, process.env);
  const command = (...args: string[]) => spawnSync(process.execPath, [cli, '--artifact', process.env.TEST_BUILD_RECEIPT!, '--config', files.config, ...args], {
    cwd: artifact.root, env, encoding: 'utf8', windowsHide: true, timeout: 45000,
  });
  return { ...files, artifact, cli, env, command };
}

test('real CLI help requires no config or DB and describes explicit staged receipt syntax', () => {
  const f = fixture();
  const result = spawnSync(process.execPath, [f.cli, '--config', join(f.root, 'absent.toml'), '--help'], { cwd: f.artifact.root, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('--artifact');
  expect(result.stdout).toContain('quarantine replay');
  expect(result.stderr).toBe('');
  expect(existsSync(f.path)).toBe(false);
});

test('package source launcher hands configuration access to the compiled artifact CLI without inherited execArgv', () => {
  const f = fixture(), trace = join(f.root, 'source-config-access.json'), preload = join(f.root, 'source-tracer.mjs');
  writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const read=fs.readFileSync;fs.readFileSync=function(path,...args){if(String(path)===${JSON.stringify(f.config)})fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv)+'\\n');return read.call(this,path,...args);};syncBuiltinESMExports();`);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(f.artifact.root, 'src/cli.ts'), '--artifact', process.env.TEST_BUILD_RECEIPT!, '--config', f.config, 'status'], {
    cwd: f.artifact.root, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ db_path: resolve(f.path), initialized: false });
  expect(existsSync(trace)).toBe(false);
  expect(existsSync(f.path)).toBe(false);
});

test.each([['ticket', 'close', '0'], ['ticket', 'merge', '1', 'NaN'], ['job', 'retry', '-1'], ['quarantine', 'replay', '0'], ['start', '--unknown'], ['status', '--port', '0'], ['start', '--port', '65536']])('real CLI rejects invalid arguments %j before any database or daemon side effect', (...args) => {
  const f = fixture();
  const result = f.command(...args);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/cli\.arguments/);
  expect(existsSync(f.path)).toBe(false);
  expect(existsSync(f.path + '.daemon.json')).toBe(false);
});

test('status is read-only on a v1 fixture and never resolves first-start cutoff', () => {
  const f = fixture();
  createV1(f.path);
  const before = readFileSync(f.path);
  const result = f.command('status');
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ running: false, schema: 1, initialized: false });
  expect(readFileSync(f.path)).toEqual(before);
  using db = new DatabaseSync(f.path, { readOnly: true });
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='health'").get()).toBeUndefined();
});

test('native manual startup, duplicate exclusion, HTTP, stop and killed-instance manual restart use exact owned identities', async () => {
  const f = fixture();
  using kernel = createKernel();
  const owned: { pid: number; created: string; image: string }[] = [];
  const runs: unknown[] = [];
  try {
    const started = f.command('start', '--port', '0');
    expect(started.error).toBeUndefined();
    expect(started.status, started.stderr).toBe(0);
    const receipt = JSON.parse(started.stdout);
    owned.push(receipt);
    runs.push({ command: [process.execPath, f.cli, '--artifact', process.env.TEST_BUILD_RECEIPT, '--config', f.config, 'start', '--port', '0'], receipt });
    expect(receipt).toMatchObject({ status: 'ready', config_path: resolve(f.config), db_path: resolve(f.path) });
    expect(receipt.created).toMatch(/^\d+$/);
    expect(receipt.port).toBeGreaterThan(0);
    expect(kernel.processIdentity(receipt.pid)).toMatchObject({ created: receipt.created });
    const page = await http(receipt.port, '/');
    expect(page.status).toBe(200); expect(page.text).toContain('Tickets');
    const state = JSON.parse((await http(receipt.port, '/api/state')).text);
    expect(state.tickets_enabled).toBe(false); expect(state.chats_enabled).toBe(false);
    const original = f.command('status');
    expect(original.status, original.stderr).toBe(0);
    const before = JSON.parse(original.stdout);
    expect(before).toMatchObject({ running: true, run_id: receipt.run_id, port: receipt.port, schema: 2 });
    const duplicate = f.command('start', '--port', '0');
    expect(duplicate.status).not.toBe(0); expect(duplicate.stderr).toContain('daemon.already-running');
    expect(JSON.parse(f.command('status').stdout).detail).toMatchObject({ store_id: before.detail.store_id, triage_after: before.detail.triage_after, run_id: receipt.run_id });
    const stopped = f.command('stop');
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ stopped: true, run_id: receipt.run_id, forced: false });
    await expect(http(receipt.port, '/')).rejects.toThrow();
    expect(JSON.parse(f.command('status').stdout).running).toBe(false);
    let expired: number, unexpired: number;
    {
      using db = openDb(f.path);
      const add = db.prepare("INSERT INTO job(kind,key,state,next_at,lease_until,lease_token,run_id,lease_seconds,created_at,updated_at) VALUES ('triage',?,'running',?,?,?,'dead-synthetic-run',120,?,?)");
      const at = new Date().toISOString();
      expired = Number(add.run('expired-before-restart', at, new Date(Date.now() - 1000).toISOString(), 'expired-token', at, at).lastInsertRowid);
      unexpired = Number(add.run('unexpired-before-restart', at, new Date(Date.now() + 3600000).toISOString(), 'unexpired-token', at, at).lastInsertRowid);
    }
    const restarted = f.command('start', '--port', '0');
    expect(restarted.status, restarted.stderr).toBe(0);
    const killed = JSON.parse(restarted.stdout); owned.push(killed); runs.push({ receipt: killed });
    expect(killed.run_id).not.toBe(receipt.run_id);
    {
      using db = new DatabaseSync(f.path, { readOnly: true });
      expect(db.prepare('SELECT state,run_id FROM job WHERE id=?').get(expired)).toMatchObject({ state: 'queued', run_id: null });
      expect(db.prepare('SELECT state,run_id FROM job WHERE id=?').get(unexpired)).toMatchObject({ state: 'running', run_id: 'dead-synthetic-run' });
    }
    expect(typeof (kernel as any).terminate).toBe('function');
    if (!(kernel as any).terminate) return;
    expect((kernel as any).terminate(killed)).toBe(true);
    const down = f.command('status');
    expect(down.status, down.stderr).toBe(0); expect(JSON.parse(down.stdout).running).toBe(false);
    expect(JSON.parse(f.command('status').stdout).run_id).toBe(killed.run_id);
    const manual = f.command('start', '--port', '0');
    expect(manual.status, manual.stderr).toBe(0);
    const last = JSON.parse(manual.stdout); owned.push(last); runs.push({ receipt: last });
    expect(last.run_id).not.toBe(killed.run_id);
    const finalStatus = JSON.parse(f.command('status').stdout);
    expect(finalStatus.detail).toMatchObject({ store_id: before.detail.store_id, triage_after: before.detail.triage_after });
    using db = new DatabaseSync(f.path, { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind IN ('triage','start_chat','forward') AND key NOT IN ('expired-before-restart','unexpired-before-restart')").get()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cursor').get()?.n).toBe(0);
    expect(f.command('stop').status).toBe(0);
  } finally {
    f.command('stop');
    for (const identity of owned) (kernel as any).terminate?.(identity);
    writeFileSync(join(f.root, 'native-command-proof.json'), JSON.stringify({ runs, cleanup: owned.map((identity) => ({ ...identity, running: (kernel as any).running?.(identity) ?? false })) }, null, 2));
  }
});

test('ticket/job/quarantine commands reuse local transactions without migration or remote calls', () => {
  const f = fixture();
  let source: number, target: number, job: number, quarantine: number;
  {
    using db = openDb(f.path);
    source = Number(db.prepare("INSERT INTO ticket(title,created_at) VALUES ('From','2026-11-06T00:00:00Z')").run().lastInsertRowid);
    target = Number(db.prepare("INSERT INTO ticket(title,created_at) VALUES ('To','2026-11-06T00:00:00Z')").run().lastInsertRowid);
    db.exec("INSERT INTO conversation(id,source,account,native_id) VALUES (1,'teams','synthetic@example.invalid','synthetic-chat')");
    db.prepare("INSERT INTO ticket_conversation(ticket,conversation,kind,\"by\",created_at) VALUES (?,1,'primary','you','2026-11-06T00:00:00Z')").run(source);
    job = Number(db.prepare("INSERT INTO job(kind,key,state,next_at,created_at,updated_at) VALUES ('triage','synthetic','queued','2026-11-06T00:00:00Z','2026-11-06T00:00:00Z','2026-11-06T00:00:00Z')").run().lastInsertRowid);
    quarantine = Number(db.prepare("INSERT INTO quarantine(source,line,error,at) VALUES ('teams','{','source.invalid-json','2026-11-06T00:00:00Z')").run().lastInsertRowid);
  }
  const show = f.command('ticket', 'show', String(source)); expect(show.status, show.stderr).toBe(0);
  expect(JSON.parse(show.stdout).ticket.title).toBe('From');
  expect(f.command('job', 'list').status).toBe(0);
  expect(f.command('job', 'park', String(job), '--reason', 'Synthetic manual hold').status).toBe(0);
  expect(f.command('job', 'retry', String(job)).status).toBe(0);
  expect(f.command('ticket', 'relink', '1', String(target)).status).toBe(0);
  expect(f.command('ticket', 'merge', String(source), String(target)).status).toBe(0);
  expect(f.command('ticket', 'close', String(target), '--reason', 'Synthetic close').status).toBe(0);
  const replay = f.command('quarantine', 'replay', String(quarantine));
  expect(replay.status).not.toBe(0); expect(replay.stderr).toContain('source.invalid-json');
  using db = new DatabaseSync(f.path, { readOnly: true });
  expect(db.prepare('SELECT merged_into FROM ticket WHERE id=?').get(source)?.merged_into).toBe(target);
  expect(db.prepare('SELECT lifecycle FROM ticket WHERE id=?').get(target)?.lifecycle).toBe('done');
  expect(db.prepare('SELECT replayed_at FROM quarantine WHERE id=?').get(quarantine)?.replayed_at).toBeNull();
});
