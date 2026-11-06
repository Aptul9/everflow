import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { CHECKOUT, GuardError, SEED_BACKUP, createRun, guardConfig, guardRun, recordOwned } from '../scripts/live-checks.ts';
import type { GuardInput, GuardedConfig } from '../scripts/live-checks.ts';
import { SCRATCH } from './support.ts';

afterEach(() => { vi.restoreAllMocks(); });

function fixture() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const base = fs.mkdtempSync(join(SCRATCH, 'live-guard-'));
  const checkout = join(base, 'synthetic checkout');
  fs.mkdirSync(join(checkout, 'data', 'backups'), { recursive: true });
  for (const name of ['data/dispatcher.db', 'data/dispatcher.db-wal', 'data/dispatcher.db-shm', 'data/teamsrelay.token']) {
    fs.writeFileSync(join(checkout, name), 'Synthetic forbidden fixture, never real state');
  }
  fs.writeFileSync(join(checkout, SEED_BACKUP), 'Synthetic seed fixture');
  fs.writeFileSync(join(checkout, 'data/backups/other.db'), 'Synthetic other backup');
  const liveRoot = join(base, 'live');
  fs.mkdirSync(liveRoot);
  const runRoot = join(liveRoot, 'run one');
  const input: GuardInput = { optIn: true, scenario: 'guard-test', liveRoot, checkout, runRoot, config: join(runRoot, 'config.toml'), db: join(runRoot, 'scratch.db') };
  return { base, checkout, liveRoot, runRoot, input };
}

function observe() {
  return [vi.spyOn(fs, 'lstatSync'), vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'openSync'),
    vi.spyOn(fs, 'existsSync'), vi.spyOn(fs, 'readdirSync'), vi.spyOn(fs.realpathSync, 'native')];
}

function refused(input: GuardInput, code: string) {
  let error: unknown;
  try { guardRun(input); } catch (caught) { error = caught; }
  expect(error, `expected refusal ${code}`).toBeInstanceOf(GuardError);
  expect((error as GuardError).code).toBe(code);
}

test('protected state, sidecars and Windows spelling aliases are refused before any filesystem call', () => {
  const f = fixture();
  const held = join(f.checkout, 'data', 'dispatcher.db');
  const cases: [Partial<GuardInput>, string][] = [
    [{ db: held }, 'db.protected'],
    [{ db: held.toUpperCase() }, 'db.protected'],
    [{ db: held.replaceAll('\\', '/') }, 'db.protected'],
    [{ db: join(f.checkout, 'data', 'DISPATCHER.DB-WAL').slice(0, -4) }, 'db.protected'],
    [{ config: held + '-wal' }, 'config.protected'],
    [{ config: held + '-shm' }, 'config.protected'],
    [{ writable: [held + '-journal'] }, 'writable.protected'],
    [{ readOnly: [join(f.checkout, 'data', 'teamsrelay.token')] }, 'read-only.protected'],
    [{ db: held + '.' }, 'db.trailing-alias'],
    [{ db: held + ' ' }, 'db.trailing-alias'],
    [{ db: held + '::$DATA' }, 'db.stream-alias'],
    [{ db: join(f.checkout, 'data', 'DISPAT~1.DB') }, 'db.short-name-alias'],
    [{ db: join(f.checkout, 'DATA~1', 'dispatcher.db') }, 'db.short-name-alias'],
    [{ db: `${f.runRoot}\\..\\..\\..\\synthetic checkout\\data\\dispatcher.db` }, 'db.traversal'],
    [{ db: `\\\\?\\${held}` }, 'db.device-or-unc'],
    [{ db: 'relative/dispatcher.db' }, 'db.not-absolute'],
    [{ db: join(f.checkout, 'data', 'other.db') }, 'db.checkout-data'],
    [{ readOnly: [f.checkout] }, 'read-only.checkout-ancestor'],
    [{ readOnly: [f.base] }, 'read-only.checkout-ancestor'],
    [{ db: join(CHECKOUT, 'data', 'dispatcher.db') }, 'db.protected'],
    [{ readOnly: [join(CHECKOUT, 'data', 'teamsrelay.token')] }, 'read-only.protected'],
    [{ seed: join(CHECKOUT, 'data', 'dispatcher.db') }, 'seed.not-named-backup'],
    [{ seed: join(f.checkout, 'data', 'dispatcher.db') }, 'seed.not-named-backup'],
    [{ seed: join(f.checkout, 'data', 'backups', 'other.db') }, 'seed.not-named-backup'],
    [{ config: join(f.liveRoot, 'outside run.toml') }, 'config.outside-run-root'],
    [{ liveRoot: 'C:/Windows/Temp/live-checks', runRoot: 'C:/Windows/Temp/live-checks/run' }, 'live-root.outside-scratch'],
    [{ readOnly: [f.liveRoot] }, 'read-only.contains-run-root'],
    [{ optIn: false }, 'live-checks.opt-in-required'],
    [{ scenario: '../escape' }, 'scenario.invalid'],
  ];
  const spies = observe();
  for (const [change, code] of cases) refused({ ...f.input, ...change }, code);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

test('links and junctions are refused even when they resolve back inside the run root', () => {
  const f = fixture();
  createRun(guardRun(f.input));
  fs.mkdirSync(join(f.runRoot, 'real'));
  fs.symlinkSync(join(f.runRoot, 'real'), join(f.runRoot, 'link'), 'junction');
  refused({ ...f.input, db: join(f.runRoot, 'link', 'scratch.db') }, 'db.link');
  refused({ ...f.input, writable: [join(f.runRoot, 'link')] }, 'writable.link');
  const aliasRoot = join(f.base, 'live alias');
  fs.symlinkSync(f.liveRoot, aliasRoot, 'junction');
  refused({ ...f.input, liveRoot: aliasRoot, runRoot: join(aliasRoot, 'run one'), config: join(aliasRoot, 'run one', 'config.toml'), db: join(aliasRoot, 'run one', 'scratch.db') }, 'live-root.link');
});

test('existing state must be owned by the run manifest and must not be hard linked', () => {
  const f = fixture();
  fs.mkdirSync(f.runRoot);
  refused(f.input, 'run-root.unowned');
  fs.rmdirSync(f.runRoot);
  let plan = createRun(guardRun(f.input));
  expect(plan.runId).toMatch(/^[0-9a-f-]{36}$/);
  fs.writeFileSync(f.input.db, 'Synthetic scratch DB');
  refused(f.input, 'db.unowned');
  plan = recordOwned(plan, f.input.db);
  expect(plan.owned).toEqual(['scratch.db']);
  fs.writeFileSync(f.input.db + '-wal', 'Synthetic WAL');
  expect(guardRun(f.input)).toMatchObject({ runId: plan.runId, owned: ['scratch.db'] });
  refused({ ...f.input, scenario: 'other-scenario' }, 'manifest.scenario-mismatch');
  fs.linkSync(f.input.db, join(f.runRoot, 'second name.db'));
  refused(f.input, 'db.hard-link');
  fs.unlinkSync(join(f.runRoot, 'second name.db'));
  fs.writeFileSync(f.input.config, '[db]\npath = "scratch.db"\n');
  fs.linkSync(f.input.config, join(f.runRoot, 'config copy.toml'));
  refused(f.input, 'config.hard-link');
});

test('only the exact named seed backup is accepted, and only as a plain unlinked file', () => {
  const f = fixture();
  const seed = join(f.checkout, SEED_BACKUP);
  expect(guardRun({ ...f.input, seed }).seed).toBe(seed);
  fs.linkSync(seed, join(f.checkout, 'data', 'backups', 'linked.db'));
  refused({ ...f.input, seed }, 'seed.hard-link');
});

test('loaded config paths must stay inside the run root or the declared read-only inputs', () => {
  const f = fixture();
  const kb = join(f.base, 'synthetic kb'), providers = join(f.base, 'providers.jsonc'), profile = join(f.base, 'teams profile');
  fs.mkdirSync(kb); fs.writeFileSync(providers, '{}'); fs.mkdirSync(profile);
  const plan = guardRun({ ...f.input, readOnly: [kb, providers, profile] });
  const cfg: GuardedConfig = { db: { path: f.input.db }, vault: { path: kb }, opencode: { directory: f.runRoot },
    triage: { provider_config_path: providers }, sources: { teams: { profile } } };
  expect(() => guardConfig(plan, cfg)).not.toThrow();
  const cases: [GuardedConfig, string][] = [
    [{ ...cfg, db: { path: join(f.runRoot, 'other.db') } }, 'config.db-mismatch'],
    [{ ...cfg, vault: { path: f.base } }, 'config.vault-unguarded'],
    [{ ...cfg, opencode: { directory: f.base } }, 'config.directory-outside-run-root'],
    [{ ...cfg, triage: { provider_config_path: join(f.base, 'other.jsonc') } }, 'config.provider-config-unguarded'],
    [{ ...cfg, sources: { teams: { profile: f.base } } }, 'config.teams-profile-unguarded'],
  ];
  for (const [value, code] of cases) {
    let error: unknown;
    try { guardConfig(plan, value); } catch (caught) { error = caught; }
    expect((error as GuardError).code).toBe(code);
  }
});
