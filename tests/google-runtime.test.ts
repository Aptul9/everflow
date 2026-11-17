import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { loadConfig } from '../src/core/config.ts';
import type { Config } from '../src/core/config.ts';
import { openDb } from '../src/core/db.ts';
import { sourceStart } from '../src/core/ingest.ts';
import { createSourceReader, sourceCommand, validateRuntimeConfig } from '../src/core/runtime.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import { scratch } from './support.ts';

const OE_URL = 'https://teams.example/communication', TOKEN = 'everflow-token-0123456789abcdef0123456789';

// [oe] with a token file next to the config, as an instance has it
function withOe(cfg: Config, token = TOKEN): Config {
  const file = join(dirname(cfg._config_path), 'oe.token');
  writeFileSync(file, token ? token + '\n' : '');
  return { ...cfg, oe: { url: OE_URL, token_file: file } };
}

test('Google source runtime validates identity settings and builds only artifact watcher commands', () => {
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT), f = scratch('google-runtime-'), cfg = loadConfig(f.config);
  const receipt = process.env.TEST_BUILD_RECEIPT!;
  for (const source of ['gchat', 'gmail'] as const) {
    expect(() => validateRuntimeConfig({ ...cfg, sources: { [source]: { enabled: true } } }, receipt)).toThrow('source.google-account-required');
  }
  expect(() => validateRuntimeConfig({ ...cfg, sources: { gchat: { enabled: true, account: 'me@example.invalid' } } }, receipt)).toThrow('source.google-self-required');
  using db = openDb(f.path);
  for (const source of ['gchat', 'gmail'] as const) {
    const command = sourceCommand({ ...cfg, sources: { [source]: { enabled: true, account: 'me@example.invalid', self_id: 'self', executable: resolve('/synthetic tools/reader.exe'), topics: 20 } } }, db, source, receipt);
    expect(command.executable).toBe(process.execPath);
    expect(command.cwd).toBe(artifact.root);
    expect(command.args.join(' ')).toContain(join('dist', 'watchers', `${source}.js`));
    expect(command.args).toContain('me@example.invalid');
    expect(command.args).toContain(resolve('/synthetic tools/reader.exe'));
    expect(command.args).not.toContain('--yes');
    expect(command.args).not.toContain('--browser-refresh');
    expect(command.args).not.toContain('--oe');
    expect(command.environment).not.toHaveProperty('EVERFLOW_OE_TOKEN');
    const oe = sourceCommand({ ...withOe(cfg), sources: { [source]: { enabled: true, account: 'me@example.invalid', self_id: 'self', executable: resolve('/synthetic tools/reader.exe'), oe: true } } }, db, source, receipt);
    expect(oe.args).toContain('--oe');
    expect(oe.args).not.toContain('--executable');
    expect(oe.environment).toMatchObject({ EVERFLOW_OE_URL: OE_URL, EVERFLOW_OE_TOKEN: TOKEN });
    if (source === 'gchat') {
      for (const setting of [true, false, 'true']) {
        const enabled = sourceCommand({ ...cfg, sources: { gchat: { enabled: true, account: 'me@example.invalid', self_id: 'self', browser_refresh: setting } } }, db, 'gchat', receipt);
        expect(enabled.args.includes('--browser-refresh')).toBe(setting === true);
      }
    }
  }
});

test('Gmail through the OE agent passes every listed mailbox; Slack requires account, user and workspace', () => {
  const f = scratch('oe-runtime-'), cfg = withOe(loadConfig(f.config)), receipt = process.env.TEST_BUILD_RECEIPT!;
  using db = openDb(f.path);
  const gmail = sourceCommand({ ...cfg, sources: { gmail: { enabled: true, oe: true, accounts: ['a@example.invalid', 'b@example.invalid'] } } }, db, 'gmail', receipt);
  expect(gmail.args.filter((_, i, all) => all[i - 1] === '--account')).toEqual(['a@example.invalid', 'b@example.invalid']);
  expect(() => validateRuntimeConfig({ ...cfg, sources: { gmail: { enabled: true, accounts: ['a@example.invalid'] } } }, receipt)).toThrow('source.google-account-required');
  expect(() => validateRuntimeConfig({ ...cfg, sources: { slack: { enabled: true, account: 'a@example.invalid', self_id: 'U1' } } }, receipt)).toThrow('source.slack-options-required');
  const slack = sourceCommand({ ...cfg, sources: { slack: { enabled: true, account: 'a@example.invalid', self_id: 'U1', workspace: 'T1' } } }, db, 'slack', receipt);
  expect(slack.args.join(' ')).toContain(join('dist', 'watchers', 'slack.js'));
  expect(slack.args.slice(slack.args.indexOf('--account'))).toEqual(['--account', 'a@example.invalid', '--self-id', 'U1', '--workspace', 'T1']);
});

test('sourceCommand puts the token in the environment, never in args', () => {
  const f = scratch('oe-token-'), cfg = withOe(loadConfig(f.config)), receipt = process.env.TEST_BUILD_RECEIPT!;
  using db = openDb(f.path);
  for (const [source, options] of [['teamsrelay', {}], ['oemail', { accounts: ['a@example.invalid'] }], ['slack', { account: 'a@example.invalid', self_id: 'U1', workspace: 'T1' }],
    ['gmail', { oe: true, account: 'a@example.invalid' }], ['gchat', { oe: true, account: 'a@example.invalid', self_id: 'self' }]] as const) {
    const command = sourceCommand({ ...cfg, sources: { [source]: { enabled: true, ...options } } }, db, source, receipt);
    expect(command.args.join(' '), source).not.toContain(TOKEN);
    expect(command.args, source).not.toContain('--host');
    expect(command.environment, source).toMatchObject({ EVERFLOW_OE_URL: OE_URL, EVERFLOW_OE_TOKEN: TOKEN });
  }
});

test('teamsrelay without [oe] is source.oe-required; empty token file is source.oe-token; host in a source is ignored and never passed', () => {
  const f = scratch('oe-required-'), base = loadConfig(f.config), receipt = process.env.TEST_BUILD_RECEIPT!;
  for (const [source, options] of [['teamsrelay', {}], ['oemail', { accounts: ['a@example.invalid'] }], ['slack', { account: 'a@example.invalid', self_id: 'U1', workspace: 'T1' }],
    ['gmail', { oe: true, account: 'a@example.invalid' }]] as const) {
    expect(() => validateRuntimeConfig({ ...base, sources: { [source]: { enabled: true, ...options } } }, receipt), source).toThrow('source.oe-required');
    expect(() => validateRuntimeConfig({ ...withOe(base, ''), sources: { [source]: { enabled: true, ...options } } }, receipt), source).toThrow('source.oe-token');
    expect(() => validateRuntimeConfig({ ...base, oe: { url: OE_URL, token_file: join(f.root, 'absent.token') }, sources: { [source]: { enabled: true, ...options } } }, receipt), source).toThrow('source.oe-token');
  }
  using db = openDb(f.path);
  const old = sourceCommand({ ...withOe(base), sources: { teamsrelay: { enabled: true, host: 'oe-vm', data_dir: '/srv/relay', owner: 'o@example.invalid' } } }, db, 'teamsrelay', receipt);
  for (const gone of ['--host', 'oe-vm', '--data-dir', '/srv/relay', '--owner', 'o@example.invalid']) expect(old.args).not.toContain(gone);
});

test('an endpoint the watchers would refuse fails at start: plain http off this machine, credentials in the url, a token with spaces', () => {
  const f = scratch('oe-start-'), base = withOe(loadConfig(f.config)), receipt = process.env.TEST_BUILD_RECEIPT!;
  const relay = { teamsrelay: { enabled: true } };
  for (const url of ['http://teams.example/communication', 'https://u:p@teams.example/communication', 'https://teams.example/communication?x=1']) {
    expect(() => validateRuntimeConfig({ ...base, oe: { ...base.oe!, url }, sources: relay }, receipt), url).toThrow('source.oe-url');
  }
  expect(() => validateRuntimeConfig({ ...base, oe: { ...base.oe!, url: 'http://127.0.0.1:8190' }, sources: relay }, receipt)).not.toThrow();
  expect(() => validateRuntimeConfig({ ...withOe(base, 'two words'), sources: relay }, receipt)).toThrow('source.oe-token');
});

test('a host left under gmail or gchat is refused, so the read path never changes silently', () => {
  const f = scratch('oe-host-'), cfg = withOe(loadConfig(f.config)), receipt = process.env.TEST_BUILD_RECEIPT!;
  expect(() => validateRuntimeConfig({ ...cfg, sources: { gmail: { enabled: true, host: 'oe-vm', account: 'a@example.invalid' } } }, receipt)).toThrow('source.host-removed');
  expect(() => validateRuntimeConfig({ ...cfg, sources: { gchat: { enabled: true, host: 'oe-vm', account: 'a@example.invalid', self_id: 'self', oe: true } } }, receipt)).toThrow('source.host-removed');
});

test('gmail with oe = false keeps the gws CLI path and gets no endpoint', () => {
  const f = scratch('oe-off-'), cfg = withOe(loadConfig(f.config)), receipt = process.env.TEST_BUILD_RECEIPT!;
  using db = openDb(f.path);
  const command = sourceCommand({ ...cfg, sources: { gmail: { enabled: true, oe: false, account: 'a@example.invalid', executable: 'gws' } } }, db, 'gmail', receipt);
  expect(command.args).not.toContain('--oe');
  expect(command.args.slice(command.args.indexOf('--executable'), command.args.indexOf('--executable') + 2)).toEqual(['--executable', 'gws']);
  expect(command.environment).not.toHaveProperty('EVERFLOW_OE_URL');
  expect(command.environment).not.toHaveProperty('EVERFLOW_OE_TOKEN');
});

test('an account taken off an explicit read list stops being known, so the next checkpoint is accepted', () => {
  const f = scratch('retire-accounts-'), cfg = loadConfig(f.config), receipt = process.env.TEST_BUILD_RECEIPT!;
  using db = openDb(f.path);
  const all = ['a@example.invalid', 'b@example.invalid', 'gone@example.invalid'];
  const run = (accounts: string[]) => sourceCommand({ ...withOe(cfg), sources: { oemail: { enabled: true, accounts } } }, db, 'oemail', receipt);
  run(all);
  const reader = createSourceReader(db, cfg, 'oemail');
  const send = (record: object) => reader.stdout(Buffer.from(JSON.stringify(record)));
  send({ source: 'oemail', accounts: all });
  const known = () => db.prepare("SELECT account FROM cursor WHERE source='oemail' AND account<>'*' ORDER BY account").all().map((row) => row.account);
  expect(known()).toEqual(all);
  const command = run(['a@example.invalid', 'B@example.invalid']);
  expect(known()).toEqual(['a@example.invalid', 'b@example.invalid']);
  expect(command.args.filter((_, i, list) => list[i - 1] === '--expected-account')).toEqual(['a@example.invalid', 'b@example.invalid']);
  const checkpoint = new Date().toISOString();
  send({ source: 'oemail', accounts: ['a@example.invalid', 'b@example.invalid'], checkpoint });
  expect(db.prepare('SELECT COUNT(*) AS n FROM quarantine').get()!.n).toBe(0);
  // relay discovers its accounts: nothing is retired there
  db.prepare("INSERT INTO cursor(source,account,since) VALUES ('teamsrelay','x@example.invalid','2026-11-07T09:00:00.000000Z')").run();
  sourceCommand({ ...withOe(cfg), sources: { teamsrelay: { enabled: true, accounts: ['y@example.invalid'] } } }, db, 'teamsrelay', receipt);
  expect(db.prepare("SELECT COUNT(*) AS n FROM cursor WHERE source='teamsrelay' AND account='x@example.invalid'").get()!.n).toBe(1);
});

test('recent-topic checkpoint survives runtime reader without claiming cursor advancement', () => {
  const f = scratch('google-health-'), cfg = loadConfig(f.config);
  using db = openDb(f.path);
  sourceStart(db, cfg, 'gchat', '2026-11-07T09:00:00Z');
  const reader = createSourceReader(db, cfg, 'gchat');
  const send = (record: object) => reader.stdout(Buffer.from(JSON.stringify(record)));
  send({ source: 'gchat', accounts: ['me@example.invalid'] });
  send({ source: 'gchat', accounts: ['me@example.invalid'], checkpoint: '2026-11-07T09:00:00Z', coverage: 'recent-topics', observed_at: '2026-11-07T10:00:00Z' });
  expect(db.prepare("SELECT since FROM cursor WHERE source='gchat' AND account='*'").get()!.since).toBe('2026-11-07T09:00:00.000000Z');
  expect(JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='gchat'").get()!.detail))).toMatchObject({ coverage: 'recent-topics' });
  send({ source: 'gchat', accounts: ['me@example.invalid'], checkpoint: '2026-11-07T10:00:00Z' });
  expect(reader.blocked).toBe(true);
  expect(db.prepare("SELECT since FROM cursor WHERE source='gchat' AND account='*'").get()!.since).toBe('2026-11-07T09:00:00.000000Z');
});
