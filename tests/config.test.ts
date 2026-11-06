import { existsSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { clientsFor, loadConfig, readJsonc } from '../src/dispatcher/config.ts';
import { scratch } from './support.ts';

function configFile(text = '') {
  const fixture = scratch();
  writeFileSync(fixture.config, '[db]\npath = "fixture.db"\n' + text);
  return fixture;
}

test('defaults to disabled tickets/chats and every approved policy value', () => {
  const { config } = configFile();
  const cfg = loadConfig(config);
  expect(cfg.tickets).toEqual({ enabled: false });
  expect(cfg.chats).toEqual({ enabled: false });
  expect(cfg.triage).toMatchObject({ tool_limit: 8, timeout_seconds: 120, min_confidence: 0.75 });
  expect(cfg.windows).toMatchObject({ outlook: 300, teams: 120, teamsrelay: 120 });
  expect(cfg.web).toEqual({ port: 8789 });
  expect(cfg.jobs).toEqual({
    triage_concurrency: 3, turn_concurrency: 4, lease_seconds: 120, renew_seconds: 30,
    backoff_initial_seconds: 10, backoff_max_seconds: 1800, backoff_jitter: 0.2,
    max_attempts: 5, max_recoveries: 2, collect_seconds: 10, sync_seconds: 300, heartbeat_seconds: 10,
    archive_hours: 24, reopen_days: 14, purge_days: 30, log_max_bytes: 10485760, log_files: 5,
  });
});

test.each(['true', 'false', '"true"', '"false"', '1', '0', '[]', '{}'])('only literal true enables rollout flags (%s)', (value) => {
  const { config } = configFile(`[tickets]\nenabled = ${value}\n[chats]\nenabled = ${value}\n`);
  const cfg = loadConfig(config);
  expect(cfg.tickets).toEqual({ enabled: value === 'true' });
  expect(cfg.chats).toEqual({ enabled: value === 'true' });
});

test('keeps client/source data and resolves instance-relative paths without opening the DB', () => {
  const { config, root, path } = configFile(`
[vault]
path = "knowledge"
[opencode]
directory = "knowledge"
url = "http://127.0.0.1:1"
model = "synthetic/model"
[clients.synthetic]
accounts = ["Me@Example.Invalid"]
domains = ["Example.Invalid"]
keywords = ["synthetic"]
custom = "retained"
[sources.teams]
account = "source@example.invalid"
read_only = true
[windows]
gchat = 120
`);
  const cfg = loadConfig(relative(process.cwd(), config));
  expect(cfg._config_path).toBe(resolve(config));
  expect(cfg.db).toEqual({ path });
  expect(cfg.vault).toEqual({ path: join(root, 'knowledge') });
  expect(cfg.opencode).toMatchObject({ directory: join(root, 'knowledge'), model: 'synthetic/model' });
  expect(cfg.clients).toMatchObject({ synthetic: { accounts: ['Me@Example.Invalid'], domains: ['Example.Invalid'], keywords: ['synthetic'], custom: 'retained' } });
  expect(cfg.sources).toEqual({ teams: { account: 'source@example.invalid', read_only: true } });
  expect(cfg.windows).toMatchObject({ gchat: 120 });
  expect(existsSync(path)).toBe(false);
});

test('obsolete v1 switches and watcher commands are ignored, never executed', () => {
  const { config, path } = configFile(`
[mode]
shadow = false
[dispatch]
enabled = true
[approval]
enabled = true
[delivery]
enabled = true
[[watchers]]
source = "synthetic"
command = ["must-not-run", "--anything"]
`);
  const cfg = loadConfig(config);
  expect(cfg.tickets).toEqual({ enabled: false });
  expect(cfg.chats).toEqual({ enabled: false });
  for (const field of ['mode', 'dispatch', 'approval', 'delivery', 'watchers']) expect(cfg[field]).toBeUndefined();
  expect(existsSync(path)).toBe(false);
});

test('explicit cutoff is normalized but remains unresolved when absent', () => {
  const { config } = configFile('[start]\ntriage_after = "2026-11-06T02:00:00.123456+02:00"\n');
  expect(loadConfig(config).start).toMatchObject({ triage_after: '2026-11-06T00:00:00.123456Z' });
  expect(loadConfig(configFile().config).start).not.toHaveProperty('triage_after');
});

test.each([
  ['triage', 'tool_limit', '0'], ['triage', 'tool_limit', '9'], ['triage', 'timeout_seconds', '121'],
  ['triage', 'min_confidence', '1.1'], ['triage', 'min_confidence', '-0.1'],
  ['triage', 'min_confidence', 'nan'], ['triage', 'min_confidence', 'inf'],
  ['windows', 'outlook', '299'], ['windows', 'teams', '119'], ['windows', 'teamsrelay', '119'],
  ['web', 'port', '0'], ['web', 'port', '65536'], ['web', 'port', '8789.5'],
  ['jobs', 'triage_concurrency', '0'], ['jobs', 'turn_concurrency', '0'],
  ['jobs', 'lease_seconds', '0'], ['jobs', 'renew_seconds', '120'],
  ['jobs', 'backoff_initial_seconds', '1801'], ['jobs', 'backoff_jitter', '1.1'],
  ['jobs', 'backoff_jitter', '-0.1'], ['jobs', 'max_attempts', '0'], ['jobs', 'max_recoveries', '-1'],
  ['jobs', 'collect_seconds', '0'], ['jobs', 'sync_seconds', '0'], ['jobs', 'heartbeat_seconds', '0'],
  ['jobs', 'archive_hours', '0'], ['jobs', 'reopen_days', '-1'], ['jobs', 'purge_days', '0'],
  ['jobs', 'log_max_bytes', '0'], ['jobs', 'log_files', '0'], ['jobs', 'max_attempts', '"5"'],
  ['start', 'triage_after', '"2026-11-06T00:00:00"'], ['start', 'triage_after', '"2026-02-30T00:00:00Z"'],
  ['start', 'triage_after', '2026-11-06T00:00:00.123456Z'],
])('rejects invalid %s.%s = %s', (section, key, value) => {
  const { config } = configFile(`[${section}]\n${key} = ${value}\n`);
  expect(() => loadConfig(config)).toThrow();
});

test('configured account matching takes precedence over sender domains, case-insensitively', () => {
  const { config } = configFile(`
[clients.account]
accounts = ["ME@EXAMPLE.INVALID"]
[clients.domain]
domains = ["Other.Invalid"]
`);
  const cfg = loadConfig(config);
  expect(clientsFor(cfg, 'me@example.invalid', ['sender@other.invalid'])).toEqual(['account']);
  expect(clientsFor(cfg, 'unassigned@else.invalid', ['SENDER@OTHER.INVALID'])).toEqual(['domain']);
  expect(clientsFor(cfg, 'me@other.invalid', ['Relay Display Name'])).toEqual(['domain']);
  expect(clientsFor(cfg, 'me@else.invalid', ['Unknown Name'])).toEqual([]);
});

test('JSONC handles comments/trailing commas while preserving URLs and quoted punctuation', () => {
  const { root } = scratch();
  const path = join(root, 'settings.jsonc');
  writeFileSync(path, '{\n// comment\n"url":"https://example.invalid/a//b", /* comment */ "text":"x,}",\n}');
  expect(() => readJsonc(path)).not.toThrow();
  expect(readJsonc(path)).toEqual({ url: 'https://example.invalid/a//b', text: 'x,}' });
});

test('JSONC rejects partial or malformed config rather than using a partial parse', () => {
  const { root } = scratch();
  const path = join(root, 'settings.jsonc');
  writeFileSync(path, '{"ok": true, "broken": }');
  expect(() => readJsonc(path)).toThrow(SyntaxError);
});
