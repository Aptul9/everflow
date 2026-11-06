import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inside, plainParents, samePath } from '../src/web/build-artifact.ts';

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
  if (cfg.triage.provider_config_path !== undefined && !plan.readOnly.some((entry) => samePath(entry, cfg.triage.provider_config_path!))) {
    refuse('config.provider-config-unguarded');
  }
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
