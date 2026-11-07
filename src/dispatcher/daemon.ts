import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Config } from './config.ts';
import { createKernel, windowsPath } from '../windows/kernel.ts';
import type { ProcessIdentity } from '../windows/kernel.ts';
import type { Source } from '../watchers/source.ts';
import { readBuildReceipt, samePath } from '../web/build-artifact.ts';
import { childEnvironment } from '../cli.ts';
export { childEnvironment } from '../cli.ts';

export class DaemonError extends Error {
  constructor(readonly code: string, readonly reason?: string) { super(code); }
}
export interface OwnedProcess extends ProcessIdentity { kind: 'watcher' | 'ssh' | 'cli'; source: Source; owner_pid: number; owner_created?: string }
export interface DaemonReceipt extends ProcessIdentity {
  version: 1; status: 'starting' | 'ready' | 'stopped'; run_id: string; config_path: string; db_path: string;
  artifact: string; port: number; started_at: string; heartbeat_at: string; argv: string[]; children: OwnedProcess[];
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function canonicalDb(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new DaemonError('daemon.absolute-db-required');
  const suffix: string[] = [];
  let current = resolve(path);
  while (!fs.existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new DaemonError('daemon.db-root');
    suffix.unshift(basename(current)); current = parent;
  }
  if (!suffix.length) {
    const stat = fs.statSync(current);
    if (!stat.isFile() || stat.nlink !== 1) throw new DaemonError('daemon.db-file');
  }
  return join(fs.realpathSync.native(current), ...suffix);
}

export function instancePaths(path: string, runId?: string) {
  const db = canonicalDb(path);
  if (runId !== undefined && !uuid.test(runId)) throw new DaemonError('daemon.run-id');
  return { db, receipt: db + '.daemon.json', pipe: '\\\\.\\pipe\\inbox-dispatcher-v2-' + createHash('sha256').update(windowsPath(db)).digest('hex'),
    ready: db + `.ready-${runId ?? 'none'}.json`, stop: db + `.stop-${runId ?? 'none'}.json` };
}

export function atomicJson(path: string, value: unknown): void {
  const temporary = path + `.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temporary, path); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EACCES', 'EPERM', 'EBUSY'].includes(code ?? '') || attempt === 9) throw error;
      // A Windows reader can temporarily deny replacement. Keep one complete candidate, at most 650ms total wait.
      Atomics.wait(wait, 0, 0, Math.min(10 * 2 ** attempt, 100));
    }
  }
}

export function readJson(path: string): unknown {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1048576) throw new DaemonError('daemon.receipt-file');
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function processIdentity(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ProcessIdentity>;
  return Number.isSafeInteger(row.pid) && Number(row.pid) > 0 && Number(row.pid) <= 0xffffffff
    && typeof row.created === 'string' && /^\d+$/.test(row.created) && typeof row.image === 'string' && isAbsolute(row.image);
}

export function readDaemonReceipt(cfg: Pick<Config, 'db' | '_config_path'>): DaemonReceipt | null {
  const paths = instancePaths(cfg.db.path), value = readJson(paths.receipt);
  if (value === null) return null;
  const row = value as Partial<DaemonReceipt>;
  if (!processIdentity(row) || row.version !== 1 || !uuid.test(row.run_id ?? '') || !['starting', 'ready', 'stopped'].includes(row.status ?? '')
    || typeof row.config_path !== 'string' || !samePath(row.config_path, cfg._config_path) || typeof row.db_path !== 'string' || !samePath(row.db_path, paths.db)
    || !Array.isArray(row.children) || row.children.length > 4096 || row.children.some((child: OwnedProcess) => !processIdentity(child)
      || !['watcher', 'ssh', 'cli'].includes(child.kind) || !['outlook', 'teams', 'teamsrelay', 'gchat', 'gmail'].includes(child.source) || !Number.isSafeInteger(child.owner_pid))) throw new DaemonError('daemon.receipt-identity');
  if (row.children.some((child) => child.kind !== 'watcher' && (typeof child.owner_created !== 'string' || !/^\d+$/.test(child.owner_created)))) throw new DaemonError('daemon.child-identity-unverified');
  return row as DaemonReceipt;
}

export async function acquireInstance(path: string) {
  const { pipe } = instancePaths(path);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => reject(new DaemonError(error.code === 'EADDRINUSE' ? 'daemon.already-running' : 'daemon.pipe', error.code)));
    server.listen({ path: pipe, exclusive: true }, resolve);
  });
  let closing: Promise<void> | undefined;
  return { pipe, close: () => closing ??= new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

export async function bounded<T>(work: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DaemonError(code)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function readyFile(path: string, runId: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let watcher: fs.FSWatcher | undefined;
    const finish = (error?: unknown, value?: Record<string, unknown>) => { clearTimeout(timer); watcher?.close(); if (error) reject(error); else resolve(value!); };
    const check = () => {
      try {
        const value = readJson(path) as Record<string, unknown> | null;
        if (value && value.run_id === runId && ['ready', 'error'].includes(String(value.status))) finish(undefined, value);
      } catch (error) { finish(error); }
    };
    const timer = setTimeout(() => finish(new DaemonError('daemon.readiness-timeout')), 30000);
    watcher = fs.watch(dirname(path), (_event, name) => { if (String(name) === basename(path)) check(); });
    watcher.once('error', (error) => finish(error)); check();
  });
}

export function cleanupChildren(children: readonly OwnedProcess[], kernel: ReturnType<typeof createKernel>): void {
  for (const child of children.filter((child) => child.kind === 'watcher')) kernel.wait(child, 1000);
  for (const child of [...children].sort((a, b) => Number(a.kind === 'watcher') - Number(b.kind === 'watcher'))) kernel.terminate(child);
}

export async function launchDaemon(cfg: Config, buildReceipt: string, port?: number) {
  const { artifact } = (await import('./runtime.ts')).validateRuntimeConfig(cfg, buildReceipt);
  const runId = randomUUID(), paths = instancePaths(cfg.db.path, runId);
  fs.mkdirSync(dirname(paths.db), { recursive: true });
  using kernel = createKernel();
  const launcher = kernel.processIdentity(process.pid), inJob = kernel.inJob(), breakaway = !inJob;
  const args = [join(artifact.root, 'dist', 'cli.js'), '--artifact', buildReceipt, '--config', cfg._config_path, '_run', '--run-id', runId, ...(port === undefined ? [] : ['--port', String(port)])];
  const identity = kernel.launchIdentity({ executable: process.execPath, args, cwd: artifact.root, environment: { ...childEnvironment(), NODE_ENV: 'production', INBOX_DISPATCHER_ARTIFACT: buildReceipt }, breakaway });
  try {
    const value = await readyFile(paths.ready, runId);
    if (value.status === 'error') throw new DaemonError(typeof value.code === 'string' ? value.code : 'daemon.startup', typeof value.reason === 'string' ? value.reason : undefined);
    if (!processIdentity(value) || value.pid !== identity.pid || value.created !== identity.created || windowsPath(String(value.image)) !== windowsPath(identity.image)
      || !samePath(String(value.config_path), cfg._config_path) || !samePath(String(value.db_path), paths.db) || !samePath(String(value.artifact), buildReceipt)
      || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535 || !kernel.running(identity)) throw new DaemonError('daemon.readiness-identity');
    return { ...value, launcher, launch: { executable: process.execPath, args, cwd: artifact.root, inherited_handles: false, in_job: inJob, breakaway, flags: breakaway ? '0x09000600' : '0x08000600' } };
  } catch (error) {
    kernel.terminate(identity);
    if (!(error instanceof DaemonError && error.code === 'daemon.already-running')) {
      const receipt = readDaemonReceipt(cfg);
      if (receipt?.created === identity.created && receipt.pid === identity.pid) cleanupChildren(receipt.children, kernel);
    }
    throw error;
  }
}

export async function stopDaemon(cfg: Pick<Config, 'db' | '_config_path'>) {
  const receipt = readDaemonReceipt(cfg);
  if (!receipt) return { stopped: true, running: false };
  using kernel = createKernel();
  const running = kernel.running(receipt);
  if (running) {
    atomicJson(instancePaths(cfg.db.path, receipt.run_id).stop, { run_id: receipt.run_id, pid: receipt.pid, created: receipt.created, at: new Date().toISOString() });
    if (kernel.wait(receipt, 15000)) { cleanupChildren(receipt.children, kernel); return { stopped: true, running: false, run_id: receipt.run_id, forced: false }; }
  }
  const latest = readDaemonReceipt(cfg);
  const children = latest?.run_id === receipt.run_id ? latest.children : receipt.children;
  if (running) kernel.terminate(receipt);
  cleanupChildren(children, kernel);
  return { stopped: true, running: false, run_id: receipt.run_id, forced: running };
}

export async function readStatus(cfg: Pick<Config, 'db' | '_config_path'>) {
  const receipt = readDaemonReceipt(cfg), path = canonicalDb(cfg.db.path);
  let running = false;
  if (receipt) { using kernel = createKernel(); running = kernel.running(receipt); }
  let schema: number | null = null, detail: Record<string, unknown> = {};
  if (fs.existsSync(path)) {
    const { DatabaseSync } = await import('node:sqlite');
    using db = new DatabaseSync(path, { readOnly: true, timeout: 30000 });
    schema = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (schema === 2 && db.prepare("SELECT 1 FROM sqlite_schema WHERE name='health' AND type='table'").get()) {
      const row = db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get();
      if (row) detail = JSON.parse(String(row.detail)) as Record<string, unknown>;
    }
  }
  return { running, initialized: schema === 2, schema, config_path: cfg._config_path, db_path: path,
    ...(receipt ? { run_id: receipt.run_id, pid: receipt.pid, created: receipt.created, port: receipt.port, children: receipt.children } : {}), detail };
}
