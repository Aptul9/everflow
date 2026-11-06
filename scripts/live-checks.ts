import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { inside, plainParents, readBuildReceipt, samePath } from '../src/web/build-artifact.ts';

export const SCRATCH_ROOT = resolve('C:/Users/Antonio/AppData/Local/Temp/opencode/inbox-dispatcher-v2');
export const LIVE_ROOT = join(SCRATCH_ROOT, 'live-checks');
export const CHECKOUT = resolve('C:/Users/Antonio/Downloads/personal projects/inbox-dispatcher');
export const SEED_BACKUP = 'data/backups/pre-review-resume-20261104-234928.db';
export const MANIFEST = 'run-manifest.json';
const PROTECTED = ['data/dispatcher.db', 'data/teamsrelay.token'];
const SIDECARS = ['', '-wal', '-shm', '-journal'];

export class GuardError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'GuardError'; this.code = code; }
}

export interface GuardInput {
  optIn: boolean;
  scenario: string;
  runRoot: string;
  config: string;
  db: string;
  writable?: string[];
  readOnly?: string[];
  seed?: string;
  liveRoot?: string;
  checkout?: string;
}

export interface RunPlan {
  scenario: string;
  liveRoot: string;
  runRoot: string;
  config: string;
  db: string;
  state: string[];
  writable: string[];
  readOnly: string[];
  seed?: string;
  manifest: string;
  owned: string[];
  runId?: string;
}

export interface GuardedConfig {
  db: { path: string };
  vault: { path: string };
  opencode: { directory: string };
  triage: { provider_config_path?: string };
  sources?: Record<string, { profile?: string } | undefined>;
}

function refuse(code: string): never { throw new GuardError(code); }

function spelling(path: unknown, role: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) refuse(`${role}.invalid`);
  if (/^[\\/]{2}/.test(path)) refuse(`${role}.device-or-unc`);
  if (!/^[A-Za-z]:[\\/]/.test(path) || !isAbsolute(path)) refuse(`${role}.not-absolute`);
  for (const part of path.slice(3).split(/[\\/]+/).filter(Boolean)) {
    if (part === '..' || part === '.') refuse(`${role}.traversal`);
    if (part.includes(':')) refuse(`${role}.stream-alias`);
    if (/[. ]$/.test(part)) refuse(`${role}.trailing-alias`);
    if (/~\d/.test(part)) refuse(`${role}.short-name-alias`);
    if (/[<>"|?*]/.test(part)) refuse(`${role}.wildcard`);
  }
  return resolve(path);
}

function forbidden(path: string, checkouts: string[], role: string, seed?: string): void {
  for (const checkout of checkouts) {
    for (const name of PROTECTED) for (const suffix of SIDECARS) {
      if (samePath(path, join(checkout, name + suffix))) refuse(`${role}.protected`);
    }
    const data = join(checkout, 'data');
    if (samePath(path, checkout) || inside(path, checkout)) refuse(`${role}.checkout-ancestor`);
    if ((samePath(path, data) || inside(data, path)) && !(seed !== undefined && samePath(path, seed))) refuse(`${role}.checkout-data`);
  }
}

function plain(path: string, role: string): void {
  try { plainParents(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') refuse(`${role}.missing`);
    if (error instanceof Error && /links or junctions/.test(error.message)) refuse(`${role}.link`);
    throw error;
  }
}

function walk(root: string, path: string, role: string): fs.Stats | undefined {
  let current = root, stat: fs.Stats | undefined;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { stat = fs.lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) refuse(`${role}.link`);
  }
  return stat;
}

function plainFile(stat: fs.Stats | undefined, role: string): void {
  if (stat === undefined) return;
  if (!stat.isFile()) refuse(`${role}.not-file`);
  if (stat.nlink !== 1) refuse(`${role}.hard-link`);
}

function readManifest(path: string): { run_id: string; scenario: string; owned: string[] } {
  const value = JSON.parse(fs.readFileSync(path, 'utf8')) as { run_id?: unknown; scenario?: unknown; owned?: unknown };
  if (typeof value.run_id !== 'string' || typeof value.scenario !== 'string' || !Array.isArray(value.owned)
    || !value.owned.every((entry) => typeof entry === 'string')) refuse('manifest.invalid');
  return value as { run_id: string; scenario: string; owned: string[] };
}

export function guardRun(input: GuardInput): RunPlan {
  if (input.optIn !== true) refuse('live-checks.opt-in-required');
  if (typeof input.scenario !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.scenario)) refuse('scenario.invalid');
  const checkout = spelling(input.checkout ?? CHECKOUT, 'checkout');
  const checkouts = samePath(checkout, CHECKOUT) ? [CHECKOUT] : [CHECKOUT, checkout];
  const liveRoot = spelling(input.liveRoot ?? LIVE_ROOT, 'live-root');
  const runRoot = spelling(input.runRoot, 'run-root');
  const config = spelling(input.config, 'config');
  const db = spelling(input.db, 'db');
  const writable = (input.writable ?? []).map((path) => spelling(path, 'writable'));
  const readOnly = (input.readOnly ?? []).map((path) => spelling(path, 'read-only'));
  const expectedSeed = join(checkout, SEED_BACKUP);
  const seed = input.seed === undefined ? undefined : spelling(input.seed, 'seed');
  const state = SIDECARS.map((suffix) => db + suffix);
  const local = [[config, 'config'] as const, ...state.map((path) => [path, 'db'] as const), ...writable.map((path) => [path, 'writable'] as const)];
  for (const [path, role] of [[liveRoot, 'live-root'] as const, [runRoot, 'run-root'] as const, ...local,
    ...readOnly.map((path) => [path, 'read-only'] as const)]) forbidden(path, checkouts, role);
  if (seed !== undefined) {
    if (!samePath(seed, expectedSeed)) refuse('seed.not-named-backup');
    forbidden(seed, checkouts, 'seed', expectedSeed);
  }
  if (!inside(SCRATCH_ROOT, liveRoot)) refuse('live-root.outside-scratch');
  if (!inside(liveRoot, runRoot)) refuse('run-root.outside-live-root');
  for (const [path, role] of local) if (!inside(runRoot, path)) refuse(`${role}.outside-run-root`);
  for (const path of readOnly) if (samePath(path, runRoot) || inside(path, runRoot)) refuse('read-only.contains-run-root');

  plain(liveRoot, 'live-root');
  if (!fs.lstatSync(liveRoot).isDirectory()) refuse('live-root.not-directory');
  if (!samePath(fs.realpathSync.native(liveRoot), liveRoot)) refuse('live-root.alias');
  const runStat = walk(liveRoot, runRoot, 'run-root');
  if (runStat !== undefined && !runStat.isDirectory()) refuse('run-root.not-directory');
  const manifest = join(runRoot, MANIFEST);
  let owned: string[] = [], runId: string | undefined;
  if (runStat !== undefined) {
    const stat = walk(liveRoot, manifest, 'manifest');
    if (stat === undefined) refuse('run-root.unowned');
    plainFile(stat, 'manifest');
    const recorded = readManifest(manifest);
    if (recorded.scenario !== input.scenario) refuse('manifest.scenario-mismatch');
    owned = recorded.owned; runId = recorded.run_id;
  }
  for (const [path, role] of local) {
    const stat = walk(liveRoot, path, role);
    if (stat !== undefined && !(role === 'writable' && stat.isDirectory())) plainFile(stat, role);
    if (stat !== undefined && role === 'db' && !owned.some((entry) => samePath(join(runRoot, entry), db))) refuse('db.unowned');
  }
  for (const path of readOnly) plain(path, 'read-only');
  if (seed !== undefined) {
    plain(seed, 'seed');
    if (!samePath(fs.realpathSync.native(dirname(seed)), dirname(seed))) refuse('seed.alias');
    plainFile(fs.lstatSync(seed), 'seed');
  }
  return { scenario: input.scenario, liveRoot, runRoot, config, db, state, writable, readOnly, ...(seed ? { seed } : {}), manifest, owned, ...(runId ? { runId } : {}) };
}

export function guardConfig(plan: RunPlan, cfg: GuardedConfig): void {
  if (!samePath(cfg.db.path, plan.db)) refuse('config.db-mismatch');
  const allowed = (path: string) => samePath(path, plan.runRoot) || inside(plan.runRoot, path) || plan.readOnly.some((entry) => samePath(entry, path));
  if (!allowed(cfg.vault.path)) refuse('config.vault-unguarded');
  if (!samePath(cfg.opencode.directory, plan.runRoot) && !inside(plan.runRoot, cfg.opencode.directory)) refuse('config.directory-outside-run-root');
  if (cfg.triage.provider_config_path !== undefined && !allowed(cfg.triage.provider_config_path)) refuse('config.provider-config-unguarded');
  for (const [name, source] of Object.entries(cfg.sources ?? {})) {
    if (source?.profile !== undefined && !plan.readOnly.some((entry) => samePath(entry, source.profile!))) refuse(`config.${name}-profile-unguarded`);
  }
}

export function createRun(plan: RunPlan): RunPlan {
  if (plan.runId !== undefined) return plan;
  fs.mkdirSync(plan.runRoot);
  const runId = randomUUID();
  fs.writeFileSync(plan.manifest, JSON.stringify({ run_id: runId, scenario: plan.scenario, created_at: new Date().toISOString(), owned: [] }, null, 2), { flag: 'wx' });
  return { ...plan, runId };
}

export function recordOwned(plan: RunPlan, path: string): RunPlan {
  if (!inside(plan.runRoot, path)) refuse('owned.outside-run-root');
  const manifest = readManifest(plan.manifest);
  if (manifest.run_id !== plan.runId) refuse('manifest.run-mismatch');
  const entry = relative(plan.runRoot, resolve(path)).split(sep).join('/');
  if (!manifest.owned.includes(entry)) manifest.owned.push(entry);
  fs.writeFileSync(plan.manifest, JSON.stringify(manifest, null, 2));
  return { ...plan, owned: manifest.owned };
}

const VAULT = resolve('C:/Users/Antonio/OneDrive/Documenti/Vault');
// A final-component symlink is resolved to its declared target, which is then guarded like any other input.
function linkTarget(path: string): string {
  const stat = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isSymbolicLink()) return path;
  const target = fs.readlinkSync(path);
  return isAbsolute(target) ? resolve(target) : resolve(dirname(path), target);
}
const OPENCODE_CONFIG = linkTarget(join(homedir(), '.config', 'opencode', 'opencode.jsonc'));
const OPENCHAMBER_SETTINGS = join(homedir(), '.config', 'openchamber', 'settings.json');
const SOURCE_CONFIG = join(CHECKOUT, 'config.toml');
const TRIAGE_ROUTE = 'meridian-everbright';

interface Harness {
  receipt: string;
  options: { tickets: boolean; chats: boolean; sources: boolean; lookback: number; profile: string; closed_port: number };
  ready: { at: string; port: number; run_id: string; pid: number; created: string; image: string }[];
  steps: { at: string; step: string; result: unknown }[];
}

type Modules = {
  config: typeof import('../src/dispatcher/config.ts');
  opencode: typeof import('../src/dispatcher/opencode.ts');
  kernel: typeof import('../src/windows/kernel.ts');
};

function compiled(receipt: string): { root: string; modules: Modules } {
  const artifact = readBuildReceipt(receipt);
  const load = createRequire(join(artifact.root, 'package.json'));
  return { root: artifact.root, modules: { config: load('./dist/dispatcher/config.js'), opencode: load('./dist/dispatcher/opencode.js'),
    kernel: load('./dist/windows/kernel.js') } };
}

function runInput(scenario: string, runRoot: string, profile: string | undefined, seed?: string): GuardInput {
  return { optIn: true, scenario, runRoot, config: join(runRoot, 'config.toml'), db: join(runRoot, 'dispatcher.db'),
    writable: [join(runRoot, 'sessions'), join(runRoot, 'providers.jsonc'), join(runRoot, 'harness.json')],
    readOnly: [VAULT, OPENCODE_CONFIG, OPENCHAMBER_SETTINGS, SOURCE_CONFIG, ...(profile ? [profile] : [])], ...(seed ? { seed } : {}) };
}

function readHarness(plan: RunPlan): Harness { return JSON.parse(fs.readFileSync(join(plan.runRoot, 'harness.json'), 'utf8')) as Harness; }
function writeHarness(plan: RunPlan, harness: Harness, step?: string, result?: unknown): void {
  if (step) harness.steps.push({ at: new Date().toISOString(), step, result });
  fs.writeFileSync(join(plan.runRoot, 'harness.json'), JSON.stringify(harness, null, 2));
}

function configText(harness: Harness): string {
  const source = fs.readFileSync(SOURCE_CONFIG, 'utf8');
  const clients = source.indexOf('[clients.');
  if (clients < 0) refuse('config.clients-missing');
  const { options: o } = harness, q = JSON.stringify;
  return `# Owned live-check instance. Paths are relative to this file.
[db]
path = "dispatcher.db"

[vault]
path = ${q(VAULT.replaceAll('\\', '/'))}

[opencode]
url = ""
directory = "sessions"
model = "meridian-everbright/claude-opus-5-5"

[tickets]
enabled = ${o.tickets}

[chats]
enabled = ${o.chats}

[triage]
providers = ["closed-loopback", ${q(TRIAGE_ROUTE)}]
model = "claude-haiku-5-5"
provider_config_path = "providers.jsonc"

[start]
lookback_minutes = ${o.lookback}

[sources.outlook]
enabled = ${o.sources}
poll_seconds = 60

[sources.teams]
enabled = ${o.sources}
poll_seconds = 30
${o.profile ? `profile = ${q(o.profile.replaceAll('\\', '/'))}` : ''}

[sources.teamsrelay]
enabled = ${o.sources}
poll_seconds = 30
host = "oe-vm"
data_dir = "/opt/teamsrelay/data"
owner = "aptul99@gmail.com"

${source.slice(clients)}`;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === 'string') refuse('providers.closed-port');
  return address.port;
}

function cli(root: string, receipt: string, config: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), '--artifact', receipt, '--config', config, ...args],
    { cwd: root, encoding: 'utf8', timeout: 240000, windowsHide: true, env: { ...process.env, NODE_ENV: 'production' } });
  const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? '';
  let value: unknown;
  try { value = JSON.parse(line); } catch { value = { stdout: result.stdout, stderr: result.stderr }; }
  return { status: result.status, error: result.error?.message, value };
}

function http(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const call = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers }, timeout: 30000 }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (part: string) => { text += part; });
      response.on('end', () => done({ status: response.statusCode ?? 0, text }));
    });
    call.on('timeout', () => call.destroy(new Error('HTTP timeout')));
    call.on('error', fail);
    call.end(body);
  });
}

function ownSession(db: DatabaseSync, plan: RunPlan, ticket: number, peer: ReturnType<Modules['opencode']['connect']>) {
  const row = db.prepare('SELECT session_id FROM ticket WHERE id=?').get(ticket);
  if (!row?.session_id) refuse('session.none');
  const store = JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()!.detail)).store_id;
  return { id: String(row.session_id), async verify() {
    const session = await peer.get(String(row.session_id));
    const tag = session.metadata?.inbox_dispatcher as { store_id?: unknown; ticket?: unknown } | undefined;
    if (tag?.store_id !== store || tag?.ticket !== ticket || !(samePath(session.location.directory, join(plan.runRoot, 'sessions')))) refuse('session.not-owned');
    return session;
  } };
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    'opt-in': { type: 'boolean' }, scenario: { type: 'string' }, 'run-root': { type: 'string' }, artifact: { type: 'string' },
    seed: { type: 'string' }, 'teams-profile': { type: 'string' }, lookback: { type: 'string' }, sources: { type: 'boolean' },
    tickets: { type: 'boolean' }, chats: { type: 'string' }, ticket: { type: 'string' }, batch: { type: 'string' }, note: { type: 'string' } } });
  const command = positionals[0];
  if (values['opt-in'] !== true) refuse('live-checks.opt-in-required');
  if (positionals.length !== 1) refuse('command.arguments');
  const runRoot = values['run-root'] ?? refuse('run-root.required');
  const scenario = values.scenario ?? refuse('scenario.invalid');
  const out = (value: unknown) => { console.log(JSON.stringify(value, null, 2)); };
  if (command === 'init') {
    const receipt = values.artifact ?? refuse('artifact.required');
    const profile = values['teams-profile'] ?? '';
    let plan = createRun(guardRun(runInput(scenario, runRoot, profile || undefined, values.seed)));
    const { modules } = compiled(receipt);
    if (plan.seed) {
      for (const suffix of ['-wal', '-journal']) if (fs.existsSync(plan.seed + suffix)) refuse('seed.sidecar-present');
      fs.copyFileSync(plan.seed, plan.db, fs.constants.COPYFILE_EXCL);
      plan = recordOwned(plan, plan.db);
      using copy = new DatabaseSync(plan.db, { readOnly: true });
      if (copy.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') refuse('seed.integrity');
    }
    fs.mkdirSync(join(plan.runRoot, 'sessions'));
    const routes = modules.config.readJsonc(OPENCODE_CONFIG) as { providers?: Record<string, { settings?: { apiKey?: unknown } }> };
    const route = routes.providers?.[TRIAGE_ROUTE] ?? refuse('providers.route-missing');
    if (route.settings?.apiKey !== undefined && route.settings.apiKey !== 'x') refuse('providers.route-has-secret');
    const port = await closedPort();
    fs.writeFileSync(join(plan.runRoot, 'providers.jsonc'), JSON.stringify({ providers: {
      'closed-loopback': { settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: '' }, headers: {} }, [TRIAGE_ROUTE]: route } }, null, 2), { flag: 'wx' });
    const harness: Harness = { receipt, options: { tickets: values.tickets === true, chats: values.chats === 'true', sources: values.sources === true,
      lookback: Number(values.lookback ?? 0), profile, closed_port: port }, ready: [], steps: [] };
    if (!Number.isSafeInteger(harness.options.lookback) || harness.options.lookback < 0 || harness.options.lookback > 1440) refuse('lookback.invalid');
    if (harness.options.sources && !profile) refuse('teams-profile.required');
    fs.writeFileSync(plan.config, configText(harness), { flag: 'wx' });
    writeHarness(plan, harness, 'init', { seed: plan.seed ?? null, options: harness.options });
    guardConfig(plan, modules.config.loadConfig(plan.config) as unknown as GuardedConfig);
    out({ runId: plan.runId, runRoot: plan.runRoot, config: plan.config, db: plan.db, seed: plan.seed ?? null, options: harness.options });
    return;
  }
  let plan = guardRun(runInput(scenario, runRoot, undefined));
  if (plan.runId === undefined) refuse('run-root.not-initialized');
  const harness = readHarness(plan);
  if (harness.options.profile) plan = guardRun(runInput(scenario, runRoot, harness.options.profile));
  const { root, modules } = compiled(harness.receipt);
  const cfg = modules.config.loadConfig(plan.config);
  guardConfig(plan, cfg as unknown as GuardedConfig);
  const last = harness.ready.at(-1);
  if (command === 'set') {
    const status = cli(root, harness.receipt, plan.config, 'status');
    if ((status.value as { running?: unknown }).running !== false) refuse('set.daemon-running');
    if (values.chats !== undefined) harness.options.chats = values.chats === 'true';
    fs.writeFileSync(plan.config, configText(harness));
    guardConfig(plan, modules.config.loadConfig(plan.config) as unknown as GuardedConfig);
    writeHarness(plan, harness, 'set', harness.options);
    out(harness.options);
  } else if (command === 'start') {
    const result = cli(root, harness.receipt, plan.config, 'start', '--port', '0');
    const ready = result.value as Harness['ready'][number] & { status?: string };
    if (fs.existsSync(plan.db)) plan = recordOwned(plan, plan.db);
    if (result.status === 0 && ready.status === 'ready') harness.ready.push({ at: new Date().toISOString(), port: ready.port, run_id: ready.run_id, pid: ready.pid, created: ready.created, image: ready.image });
    writeHarness(plan, harness, 'start', result);
    out(result);
  } else if (command === 'stop' || command === 'status') {
    const result = cli(root, harness.receipt, plan.config, command);
    writeHarness(plan, harness, command, result);
    out(result);
  } else if (command === 'kill') {
    if (!last) refuse('kill.no-identity');
    using kernel = modules.kernel.createKernel();
    const identity = { pid: last.pid, created: last.created, image: last.image };
    if (!kernel.running(identity)) refuse('kill.not-running');
    const killed = kernel.terminate(identity);
    const result = { identity, killed, running: kernel.running(identity) };
    writeHarness(plan, harness, 'kill', result);
    out(result);
  } else if (command === 'state') {
    if (!last) refuse('state.no-daemon');
    const page = await http(last.port, 'GET', '/');
    const state = await http(last.port, 'GET', '/api/state');
    const value = JSON.parse(state.text) as { tickets_enabled: boolean; chats_enabled: boolean; groups: Record<string, { id: number; stage: string; report: string | null; title: string; session_title: string | null }[]>;
      skipped: unknown[]; health: { dependency: string; state: string; last_error: string | null }[]; problems: Record<string, unknown[]> };
    const summary = { page: page.status, pageHasTickets: page.text.includes('Tickets'), api: state.status, tickets_enabled: value.tickets_enabled, chats_enabled: value.chats_enabled,
      groups: Object.fromEntries(Object.entries(value.groups).map(([name, cards]) => [name, cards.map((card) => ({ id: card.id, stage: card.stage, report: card.report, session_title: card.session_title }))])),
      skipped: value.skipped.length, problems: Object.fromEntries(Object.entries(value.problems).map(([name, rows]) => [name, rows.length])),
      health: value.health.map((row) => ({ dependency: row.dependency, state: row.state, last_error: row.last_error?.slice(0, 160) ?? null })) };
    writeHarness(plan, harness, 'state', summary);
    out({ ...summary, titles: Object.fromEntries(Object.values(value.groups).flat().map((card) => [card.id, card.title.slice(0, 80)])) });
  } else if (command === 'detail') {
    if (!last) refuse('detail.no-daemon');
    const ticket = Number(values.ticket);
    const detail = await http(last.port, 'GET', `/api/ticket/${ticket}`);
    const value = JSON.parse(detail.text) as { ticket: Record<string, unknown>; messages: { source: string; message_id: string }[]; timeline: { kind: string; body: string }[] };
    const result = { status: detail.status, lifecycle: value.ticket.lifecycle, stage: value.ticket.stage, report: value.ticket.report, report_line: value.ticket.report_line,
      session_title: value.ticket.session_title, messages: value.messages.map((m) => ({ source: m.source, message_id: m.message_id })), timeline: value.timeline.map((t) => t.kind) };
    writeHarness(plan, harness, `detail:${ticket}`, result);
    out({ ...result, summary: value.ticket.summary, ask: value.ticket.ask, client: value.ticket.client });
  } else if (command === 'approve' || command === 'make-ticket') {
    if (!last) refuse(`${command}.no-daemon`);
    const id = Number(command === 'approve' ? values.ticket : values.batch);
    if (!Number.isSafeInteger(id) || id <= 0) refuse(`${command}.id`);
    const page = await http(last.port, 'GET', '/');
    const token = /<meta name="dispatcher-token" content="([a-f0-9]{64})"/.exec(page.text)?.[1] ?? refuse(`${command}.token-missing`);
    const body = command === 'approve' ? JSON.stringify({ note: values.note ?? refuse('approve.note-required') }) : '{}';
    const result = await http(last.port, 'POST', command === 'approve' ? `/api/ticket/${id}/chat` : `/api/batch/${id}/ticket`, { origin: `http://127.0.0.1:${last.port}`,
      'x-dispatcher-token': token, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body);
    writeHarness(plan, harness, `${command}:${id}`, { status: result.status, response: result.text });
    out(result);
  } else if (command === 'remote') {
    using db = new DatabaseSync(plan.db, { readOnly: true });
    const ticket = Number(values.ticket);
    const peer = modules.opencode.connect(cfg);
    const session = ownSession(db, plan, ticket, peer);
    const remote = await session.verify();
    const settings = JSON.parse(fs.readFileSync(OPENCHAMBER_SETTINGS, 'utf8')) as { desktopLocalPort: number; desktopUiPassword?: string };
    const url = `http://127.0.0.1:${settings.desktopLocalPort}`;
    const fetcher = modules.opencode.authenticatedFetch({ url, password: settings.desktopUiPassword ?? '', openchamber: true, timeoutMs: 30000 });
    const messages: { id: string; type: string; parts: string[]; outcome?: string }[] = [];
    let cursor: string | undefined;
    do {
      const response = await fetcher(`${url}/api/session/${encodeURIComponent(session.id)}/message?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=asc'}`);
      const page = await response.json() as { data: { id: string; type: string; content?: { type: string }[]; outcome?: string }[]; cursor?: { next?: string } };
      for (const message of page.data) messages.push({ id: message.id, type: message.type, parts: (message.content ?? []).map((part) => part.type), ...(message.outcome ? { outcome: message.outcome } : {}) });
      cursor = page.cursor?.next;
    } while (cursor);
    const result = { ticket, session: session.id, title: remote.title, archived: remote.time.archived !== undefined, running: await peer.running(session.id),
      inbox: (await peer.inbox(session.id)).length, users: messages.filter((m) => m.type === 'user').map((m) => m.id),
      tools: messages.flatMap((m) => m.parts).filter((part) => /tool/.test(part)).length, messages };
    writeHarness(plan, harness, `remote:${ticket}`, result);
    out(result);
  } else if (command === 'inspect') {
    using db = new DatabaseSync(plan.db, { readOnly: true });
    const result = { integrity: db.prepare('PRAGMA integrity_check').get(), fk: db.prepare('PRAGMA foreign_key_check').all().length,
      tickets: db.prepare('SELECT id,lifecycle,approved_at IS NOT NULL AS approved,session_id,report,report_line,report_at,session_title,archived_at FROM ticket ORDER BY id').all(),
      turns: db.prepare('SELECT id,ticket,kind,state,outcome,prompt_id,session_id,recovery_of,recovery_count,error_class FROM turn ORDER BY id').all(),
      jobs: db.prepare("SELECT kind,state,COUNT(*) AS n FROM job GROUP BY kind,state ORDER BY kind,state").all(),
      parked: db.prepare("SELECT id,kind,ticket,error_class,substr(last_error,1,200) AS error FROM job WHERE state='parked'").all(),
      batches: db.prepare('SELECT outcome,state,COUNT(*) AS n FROM batch GROUP BY outcome,state ORDER BY outcome,state').all(),
      messages: db.prepare('SELECT source,COUNT(*) AS n FROM message GROUP BY source').all(),
      triage: db.prepare('SELECT action,COUNT(*) AS n FROM triage_log GROUP BY action').all(),
      cursors: db.prepare('SELECT source,COUNT(*) AS accounts FROM cursor GROUP BY source').all(),
      daemon: (({ store_id, triage_after }) => ({ store_id, triage_after }))(JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()?.detail ?? '{}')) as Record<string, unknown>) };
    writeHarness(plan, harness, 'inspect', result);
    out(result);
  } else if (command === 'interrupt' || command === 'archive') {
    using db = new DatabaseSync(plan.db, { readOnly: true });
    const peer = modules.opencode.connect(cfg);
    const tickets = command === 'interrupt' ? [Number(values.ticket)] : db.prepare('SELECT id FROM ticket WHERE session_id IS NOT NULL ORDER BY id').all().map((row) => Number(row.id));
    const results: unknown[] = [];
    for (const ticket of tickets) {
      const session = ownSession(db, plan, ticket, peer);
      const remote = await session.verify();
      const running = await peer.running(session.id), inbox = (await peer.inbox(session.id)).length;
      if (command === 'interrupt') {
        if (!running) refuse('interrupt.not-running');
        const settings = JSON.parse(fs.readFileSync(OPENCHAMBER_SETTINGS, 'utf8')) as { desktopLocalPort: number; desktopUiPassword?: string };
        const url = `http://127.0.0.1:${settings.desktopLocalPort}`;
        const fetcher = modules.opencode.authenticatedFetch({ url, password: settings.desktopUiPassword ?? '', openchamber: true, timeoutMs: 30000 });
        const response = await fetcher(`${url}/api/session/${encodeURIComponent(session.id)}/interrupt?resume=false`, { method: 'POST' });
        results.push({ ticket, session: session.id, status: response.status, body: (await response.text()).slice(0, 200) });
      } else if (remote.time.archived !== undefined) results.push({ ticket, session: session.id, archived: 'already' });
      else if (running || inbox) results.push({ ticket, session: session.id, archived: false, running, inbox });
      else { await peer.archive(session.id, true); results.push({ ticket, session: session.id, archived: (await peer.get(session.id)).time.archived !== undefined }); }
    }
    writeHarness(plan, harness, command, results);
    out(results);
  } else refuse('command.unknown');
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(JSON.stringify({ error: error instanceof GuardError ? error.code : error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
