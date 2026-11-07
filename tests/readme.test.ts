import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { isolatedEnvironment } from '../scripts/build.ts';
import { nativeBuildEnv } from '../scripts/setup.ts';
import { HELP, parseCommand } from '../src/cli.ts';
import { loadConfig } from '../src/dispatcher/config.ts';
import { openDb, prepareStart } from '../src/dispatcher/db.ts';
import { backoff } from '../src/dispatcher/jobs.ts';
import { makeTicket } from '../src/dispatcher/tickets.ts';
import { createKernel } from '../src/windows/kernel.ts';
import type { ProcessIdentity } from '../src/windows/kernel.ts';
import { readBuildReceipt, samePath } from '../src/web/build-artifact.ts';
import { scratch } from './support.ts';
import { http } from './web-support.ts';

function readme() {
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  expect(samePath(process.cwd(), artifact.root)).toBe(true);
  const supplied = artifact.files.find(({ path }) => path === 'README.md');
  expect(supplied, 'The actual root README must be supplied by the source-only build').toBeDefined();
  const bytes = fs.readFileSync(join(artifact.root, 'README.md'));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(supplied!.sha256);
  return { artifact, text: bytes.toString('utf8') };
}

function section(title: string, input = readme().text) {
  const text = input.replaceAll('\r\n', '\n'), heading = `## ${title}\n`;
  expect(text, `Missing operating section: ${title}`).toContain(heading);
  return text.split(heading)[1]!.split('\n## ')[0]!;
}

function block(title: string, language: string) {
  const content = section(title).split('```' + language + '\n')[1];
  expect(content, `Missing ${language} example: ${title}`).toBeDefined();
  return content!.split('\n```')[0]!;
}

function fixture() {
  const { artifact } = readme(), f = scratch('phase9 documented instance ');
  fs.writeFileSync(f.config, block('Disabled instance', 'toml'));
  const cli = join(artifact.root, 'dist/cli.js'), receipt = process.env.TEST_BUILD_RECEIPT!;
  const env = isolatedEnvironment(artifact.root, process.env), commands: unknown[] = [];
  const variables: Record<string, string> = { $cli: cli, $receipt: receipt, $config: f.config, $job: '1', $ticket: '1',
    $sourceTicket: '1', $targetTicket: '2', $conversation: '1', $quarantine: '1' };
  const command = (line: string) => {
    const tokens = (line.match(/'[^']*'|\S+/g) ?? []).map((token) => token.startsWith("'") ? token.slice(1, -1) : variables[token] ?? token);
    expect(tokens.slice(0, 3)).toEqual(['&', 'node', cli]);
    const args = tokens.slice(3), parsed = parseCommand(args, undefined);
    if (parsed.name !== 'help') {
      expect(parsed.buildReceipt).toBe(resolve(receipt));
      expect(parsed.configPath).toBe(resolve(f.config));
      expect(isAbsolute(parsed.configPath!)).toBe(true);
    }
    const bindings = Object.entries(variables).map(([name, value]) => `${name}='${value.replaceAll("'", "''")}'`).join('\n');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${bindings}\n${line}\nexit $LASTEXITCODE`],
      { cwd: artifact.root, env, encoding: 'utf8', windowsHide: true, timeout: 45000 });
    commands.push({ line, args, cwd: artifact.root, status: result.status, stdout: result.stdout, stderr: result.stderr });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return parsed.name === 'help' ? result.stdout : JSON.parse(result.stdout);
  };
  const lines = (title: string) => block(title, 'powershell').split('\n').filter((line) => line.startsWith('& node $cli '));
  return { ...f, artifact, cli, receipt, env, commands, command, lines };
}

test('README is an actual hashed stage input and every source link resolves in the supplied artifact', () => {
  const { artifact, text } = readme();
  expect(artifact.files.filter(({ path }) => path.endsWith('.md')).map(({ path }) => path)).toEqual(['README.md']);
  const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]!);
  expect(links.length).toBeGreaterThan(5);
  for (const link of links) {
    expect(link).not.toMatch(/^https?:|^\/|\.\./);
    expect(artifact.files.some(({ path }) => path === link.split('#')[0])).toBe(true);
  }
});

test('documentation sections accept Windows checkout CRLF without changing the supplied-byte hash contract', () => {
  const { text } = readme();
  expect(section('Build', text.replace(/\r?\n/g, '\r\n'))).toBe(section('Build', text));
});

test('documented defaults equal the exported config and dependency backoff, with only literal true enabling work', () => {
  const f = fixture();
  const { loadConfig: compiledLoadConfig } = createRequire(import.meta.url)(join(f.artifact.root, 'dist/dispatcher/config.js')) as { loadConfig: typeof loadConfig };
  const cfg = compiledLoadConfig(f.config);
  expect(cfg).toEqual(loadConfig(f.config));
  expect(JSON.parse(block('Runtime defaults', 'json'))).toEqual({ tickets: cfg.tickets, chats: cfg.chats, web: cfg.web,
    triage: cfg.triage, windows: cfg.windows, jobs: cfg.jobs, start: cfg.start });
  expect(cfg.tickets.enabled).toBe(false); expect(cfg.chats.enabled).toBe(false);
  expect(cfg.sources).toEqual({ outlook: { enabled: false }, teams: { enabled: false }, teamsrelay: { enabled: false }, gchat: { enabled: false }, gmail: { enabled: false } });
  for (const literal of ['true', '"true"']) {
    fs.writeFileSync(f.config, block('Disabled instance', 'toml').replaceAll('enabled = false', `enabled = ${literal}`));
    expect(compiledLoadConfig(f.config).tickets.enabled).toBe(literal === 'true');
    expect(compiledLoadConfig(f.config).chats.enabled).toBe(literal === 'true');
  }
  expect([1, 2, 3].map((count) => backoff(count, cfg.jobs, undefined, 0.5))).toEqual([10, 20, 40]);
  expect(backoff(1, cfg.jobs, undefined, 0)).toBe(8);
  expect(backoff(1, cfg.jobs, undefined, 1)).toBe(12.000000000000002);
  expect(backoff(20, cfg.jobs, undefined, 1)).toBe(1800);
  expect(backoff(1, cfg.jobs, 2400, 0)).toBe(2400);
  expect(fs.existsSync(f.path)).toBe(false);
});

test('build and verify-only instructions match the shipped controller and execute native verification without reinstalling', () => {
  const f = fixture();
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { engines: { node: string }; scripts: Record<string, string> };
  expect(pkg.engines.node).toBe('26.4.0');
  expect(block('Build', 'powershell').trim()).toBe('npm run build');
  expect(pkg.scripts.build).toBe('node scripts/build.ts');
  expect(JSON.parse(block('Native verification', 'json'))).toEqual(nativeBuildEnv({}));
  const line = block('Native verification', 'powershell').trim();
  expect(line).toBe("& node (Join-Path $build.root 'scripts/setup.ts') --verify-only --log (Join-Path $scratch 'native-verify.log')");
  const log = join(f.root, 'native-verify.log');
  const bindings = `$build=@{root='${f.artifact.root.replaceAll("'", "''")}'}\n$scratch='${f.root.replaceAll("'", "''")}'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${bindings}\n${line}\nexit $LASTEXITCODE`], {
    cwd: f.artifact.root, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ node: 'v26.4.0', status: 0, loaded: { koffi: '3.3.7', winax: '3.6.10' },
    generated: { clang: 0, enable_lto: 'false', enable_thin_lto: 'false', lto_jobs: '' } });
  expect(fs.readFileSync(log, 'utf8')).toContain('"status": 0');
});

test('documented source prerequisites construct only artifact Node commands and fail closed without required options', () => {
  const f = fixture(), cfg = loadConfig(f.config), sources = section('Sources');
  const runtime = createRequire(import.meta.url)(join(f.artifact.root, 'dist/dispatcher/runtime.js')) as typeof import('../src/dispatcher/runtime.ts');
  expect(runtime.validateRuntimeConfig(cfg, f.receipt).settings).toEqual(cfg.sources);
  expect(sources).toContain('`[sources.teams] profile`');
  expect(sources).toContain('`[sources.teamsrelay] host`');
  const entries = [...sources.matchAll(/`(dist\/watchers\/[^`]+\.js)`/g)].map((match) => match[1]!);
  expect(entries).toHaveLength(5);
  expect(() => runtime.validateRuntimeConfig({ ...cfg, sources: { teams: { enabled: true } } }, f.receipt)).toThrow('source.profile-required');
  expect(() => runtime.validateRuntimeConfig({ ...cfg, sources: { teamsrelay: { enabled: true } } }, f.receipt)).toThrow('source.relay-options-required');
  using db = openDb(f.path);
  for (const [source, options] of [
    ['outlook', {}], ['teams', { profile: join(f.root, 'synthetic profile never read') }],
    ['teamsrelay', { host: 'synthetic.invalid', data_dir: '/synthetic saved relay', owner: 'synthetic@example.invalid' }],
    ['gchat', { account: 'synthetic@example.invalid', self_id: 'synthetic-self' }], ['gmail', { account: 'synthetic@example.invalid' }],
  ] as const) {
    const command = runtime.sourceCommand({ ...cfg, sources: { [source]: { enabled: true, ...options } } }, db, source, f.receipt);
    expect(command.executable).toBe(process.execPath);
    expect(command.cwd).toBe(f.artifact.root);
    expect(command.args.some((arg) => entries.some((entry) => samePath(arg, join(f.artifact.root, entry))))).toBe(true);
    expect(command.args).toContain('--since');
    if (source === 'teams') expect(command.args).toContain('--use-system-ca');
  }
});

test('documented test launcher preserves all caller metadata and selects React test mode in its child environment', () => {
  const f = fixture();
  const launcher = block('Test gates', 'powershell').split("$run = @'\n")[1]?.split("\n'@")[0];
  expect(launcher).toBeDefined();
  const prefix = launcher!.split('\nfor (const args of [')[0]!;
  expect(prefix.length).toBeLessThan(launcher!.length);
  const reactProbe = "import * as React from 'react'; console.log(JSON.stringify({ nodeEnv: process.env.NODE_ENV, act: typeof React.act }));";
  const code = `${prefix}\nconst result = spawnSync(process.execPath, ['--input-type=module-typescript', '--eval', ${JSON.stringify(reactProbe)}], { cwd: artifact.root, env, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
console.log(JSON.stringify({ react: JSON.parse(result.stdout), receipt: env.TEST_BUILD_RECEIPT, artifact: env.INBOX_DISPATCHER_ARTIFACT,
  legacy: env.TEST_TRACKED_LEGACY_PATHS, root: env.INBOX_DISPATCHER_BUILD_ROOT }));`;
  const result = spawnSync(process.execPath, ['--input-type=module-typescript', '--eval', code], { cwd: f.artifact.root,
    env: { ...f.env, TEST_BUILD_RECEIPT: f.receipt, INBOX_DISPATCHER_ARTIFACT: f.receipt, TEST_TRACKED_LEGACY_PATHS: process.env.TEST_TRACKED_LEGACY_PATHS },
    encoding: 'utf8', windowsHide: true, timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ react: { nodeEnv: 'test', act: 'function' }, receipt: f.receipt, artifact: f.receipt,
    legacy: process.env.TEST_TRACKED_LEGACY_PATHS, root: f.artifact.root });
});

test('documented compiled help and manual commands start, serve, report and stop only an explicit synthetic instance', async () => {
  const f = fixture();
  expect(f.command(block('CLI help', 'powershell').trim())).toBe(HELP);
  expect(fs.existsSync(f.path)).toBe(false);
  const lines = f.lines('Manual commands');
  expect(lines.length).toBe(4);
  using kernel = createKernel();
  let identity: ProcessIdentity | undefined;
  try {
    expect(f.command(lines[0]!)).toMatchObject({ running: false, initialized: false, db_path: resolve(f.path) });
    expect(fs.existsSync(f.path)).toBe(false);
    const ready = f.command(lines[1]!); identity = ready;
    expect(ready).toMatchObject({ status: 'ready', config_path: resolve(f.config), artifact: resolve(f.receipt), children: [] });
    const page = await http(ready.port, '/');
    expect(page.status).toBe(200); expect(page.text).toContain('Tickets');
    const state = JSON.parse((await http(ready.port, '/api/state')).text);
    expect(state).toMatchObject({ tickets_enabled: false, chats_enabled: false, problems: { jobs: [], quarantine: [], triage: [] } });
    const healthScript = block('Source health', 'powershell');
    const health = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'\n$port=${ready.port}\n${healthScript}`],
      { cwd: f.artifact.root, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    expect(health.status, health.stderr).toBe(0);
    expect(JSON.parse(health.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ dependency: 'daemon', state: 'ok' })]));
    f.commands.push({ healthScript, port: ready.port, status: health.status, stdout: health.stdout, stderr: health.stderr });
    expect(f.command(lines[2]!)).toMatchObject({ running: true, schema: 2, run_id: ready.run_id, children: [] });
    expect(f.command(lines[3]!)).toMatchObject({ stopped: true, running: false, run_id: ready.run_id, forced: false });
    expect(kernel.running(identity!)).toBe(false);
    await expect(http(ready.port, '/')).rejects.toThrow();
    expect(f.command(lines[2]!)).toMatchObject({ running: false, run_id: ready.run_id, children: [] });
  } finally {
    let cleanupError: unknown;
    try { f.command('& node $cli --artifact $receipt --config $config stop'); }
    catch (error) { cleanupError = error instanceof Error ? error.message : String(error); }
    const forcedCleanup = identity && kernel.running(identity) ? kernel.terminate(identity) : false;
    const running = identity ? kernel.running(identity) : false;
    fs.writeFileSync(join(f.root, 'documented-commands.json'), JSON.stringify({ artifact: f.receipt, config: f.config, commands: f.commands, cleanup: { identity, forcedCleanup, running, cleanupError } }, null, 2));
    expect(cleanupError).toBeUndefined();
    expect(running, 'Owned documented daemon must be terminal').toBe(false);
  }
});

test('documented correction and replay commands perform their real local transactions', () => {
  const f = fixture();
  {
    using db = openDb(f.path);
    db.exec(`INSERT INTO ticket(id,title,created_at) VALUES (1,'Synthetic source','2026-11-06T00:00:00Z'),(2,'Synthetic target','2026-11-06T00:00:00Z');
      INSERT INTO conversation(id,source,account,native_id) VALUES (1,'teams','synthetic@example.invalid','synthetic-chat');
      INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (1,1,'primary','you','2026-11-06T00:00:00Z');
      INSERT INTO job(id,kind,key,state,attempts,failures,next_at,created_at,updated_at) VALUES (1,'triage','synthetic','queued',2,2,'2026-11-06T00:00:00Z','2026-11-06T00:00:00Z','2026-11-06T00:00:00Z');`);
    for (let id = 1; id <= 2; id++) db.prepare('INSERT INTO quarantine(id,source,line,error,at) VALUES (?,\'teams\',?,\'synthetic.valid-replay\',\'2026-11-06T00:00:00Z\')')
      .run(id, JSON.stringify({ source: 'teams', account: 'synthetic@example.invalid', conversation_id: 'replay-chat', message_id: `replay-${id}`,
        sender_is_me: false, sent_at: '2026-11-06T00:00:00Z', text: 'Synthetic replay, no source access' }));
  }
  const lines = f.lines('Local remedies');
  expect(lines.length).toBe(9);
  for (const line of lines) f.command(line);
  using db = new DatabaseSync(f.path, { readOnly: true });
  expect(db.prepare('SELECT state,attempts,failures,error_class FROM job WHERE id=1').get()).toMatchObject({ state: 'queued', attempts: 0, failures: 0, error_class: null });
  expect(db.prepare('SELECT merged_into FROM ticket WHERE id=1').get()?.merged_into).toBe(2);
  expect(db.prepare('SELECT lifecycle,report_line FROM ticket WHERE id=2').get()).toMatchObject({ lifecycle: 'done', report_line: 'Resolved locally' });
  expect(db.prepare('SELECT ticket,kind FROM ticket_conversation WHERE conversation=1 AND ticket=2').get()).toMatchObject({ ticket: 2, kind: 'linked' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM quarantine WHERE replayed_at IS NOT NULL').get()?.n).toBe(2);
  expect(db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(2);
  fs.writeFileSync(join(f.root, 'documented-remedies.json'), JSON.stringify({ artifact: f.receipt, config: f.config, commands: f.commands }, null, 2));
});

test('documented stored-at cutoff persists once and Make ticket promotes a backlog batch without approving a chat', () => {
  const f = fixture();
  expect(section('Backlog and migration')).toContain('stored_at');
  expect(section('Backlog and migration')).toContain('Make ticket');
  using db = openDb(f.path);
  db.exec(`INSERT INTO conversation(id,source,account,native_id) VALUES (1,'teams','synthetic@example.invalid','backlog');
    INSERT INTO message(source,message_id,conversation,sender_is_me,sent_at,text,stored_at) VALUES ('teams','backlog',1,0,'2026-11-05T00:00:00Z','Synthetic backlog','2026-11-06T00:00:00Z');`);
  const cutoff = prepareStart(db, '2026-11-06T00:00:01Z');
  expect(prepareStart(db, '2027-01-01T00:00:00Z')).toBe(cutoff);
  const batch = Number(db.prepare("SELECT id FROM batch WHERE outcome='backlog'").get()!.id);
  const ticket = makeTicket(db, batch);
  expect(db.prepare('SELECT lifecycle,approved_at,session_id FROM ticket WHERE id=?').get(ticket)).toMatchObject({ lifecycle: 'proposed', approved_at: null, session_id: null });
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()?.n).toBe(0);
});

test('documented Git metadata preserves an empty JSON array, source-root paths with spaces and command failure', () => {
  const script = block('Git metadata', 'powershell'), f = scratch('phase9 Git source with spaces ');
  const run = (source: string) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'\n$source='${source.replaceAll("'", "''")}'\n${script}\nWrite-Output $env:TEST_TRACKED_LEGACY_PATHS`],
  { cwd: readme().artifact.root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const init = spawnSync('git', ['init', '--quiet', f.root], { encoding: 'utf8', windowsHide: true });
  expect(init.status, init.stderr).toBe(0);
  const empty = run(f.root);
  expect(empty.status, empty.stderr).toBe(0); expect(empty.stdout.trim()).toBe('[]');
  fs.writeFileSync(join(f.root, 'legacy with spaces.py'), '# Synthetic Git-index metadata, never executed\n');
  const add = spawnSync('git', ['-C', f.root, 'add', '--', 'legacy with spaces.py'], { encoding: 'utf8', windowsHide: true });
  expect(add.status, add.stderr).toBe(0);
  const tracked = run(f.root);
  expect(tracked.status, tracked.stderr).toBe(0); expect(JSON.parse(tracked.stdout)).toEqual(['legacy with spaces.py']);
  const missing = run(join(f.root, 'absent source'));
  expect(missing.status).not.toBe(0); expect(missing.stdout.trim()).not.toBe('[]');
  expect(missing.stderr).toContain('Git index inventory failed');
});
