import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { loadConfig } from '../src/core/config.ts';
import { openDb } from '../src/core/db.ts';
import { sourceStart } from '../src/core/ingest.ts';
import { createSourceReader, sourceCommand, validateRuntimeConfig } from '../src/core/runtime.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import { scratch } from './support.ts';

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
    expect(command.args).not.toContain('--host');
    const oe = sourceCommand({ ...cfg, sources: { [source]: { enabled: true, account: 'me@example.invalid', self_id: 'self', executable: resolve('/synthetic tools/reader.exe'), host: 'oe-vm' } } }, db, source, receipt);
    expect(oe.args.slice(oe.args.indexOf('--host'), oe.args.indexOf('--host') + 2)).toEqual(['--host', 'oe-vm']);
    expect(oe.args).not.toContain('--executable');
    if (source === 'gchat') {
      for (const setting of [true, false, 'true']) {
        const enabled = sourceCommand({ ...cfg, sources: { gchat: { enabled: true, account: 'me@example.invalid', self_id: 'self', browser_refresh: setting } } }, db, 'gchat', receipt);
        expect(enabled.args.includes('--browser-refresh')).toBe(setting === true);
      }
    }
  }
});

test('Gmail through the OE agent passes every listed mailbox; Slack requires host, account, user and workspace', () => {
  const f = scratch('oe-runtime-'), cfg = loadConfig(f.config), receipt = process.env.TEST_BUILD_RECEIPT!;
  using db = openDb(f.path);
  const gmail = sourceCommand({ ...cfg, sources: { gmail: { enabled: true, host: 'oe-vm', accounts: ['a@example.invalid', 'b@example.invalid'] } } }, db, 'gmail', receipt);
  expect(gmail.args.filter((_, i, all) => all[i - 1] === '--account')).toEqual(['a@example.invalid', 'b@example.invalid']);
  expect(() => validateRuntimeConfig({ ...cfg, sources: { gmail: { enabled: true, accounts: ['a@example.invalid'] } } }, receipt)).toThrow('source.google-account-required');
  expect(() => validateRuntimeConfig({ ...cfg, sources: { slack: { enabled: true, host: 'oe-vm', account: 'a@example.invalid', self_id: 'U1' } } }, receipt)).toThrow('source.slack-options-required');
  const slack = sourceCommand({ ...cfg, sources: { slack: { enabled: true, host: 'oe-vm', account: 'a@example.invalid', self_id: 'U1', workspace: 'T1' } } }, db, 'slack', receipt);
  expect(slack.args.join(' ')).toContain(join('dist', 'watchers', 'slack.js'));
  expect(slack.args.slice(slack.args.indexOf('--host'))).toEqual(['--host', 'oe-vm', '--account', 'a@example.invalid', '--self-id', 'U1', '--workspace', 'T1']);
});

test('an account taken off an explicit read list stops being known, so the next checkpoint is accepted', () => {
  const f = scratch('retire-accounts-'), cfg = loadConfig(f.config), receipt = process.env.TEST_BUILD_RECEIPT!;
  using db = openDb(f.path);
  const all = ['a@example.invalid', 'b@example.invalid', 'gone@example.invalid'];
  const run = (accounts: string[]) => sourceCommand({ ...cfg, sources: { oemail: { enabled: true, host: 'oe-vm', accounts } } }, db, 'oemail', receipt);
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
  sourceCommand({ ...cfg, sources: { teamsrelay: { enabled: true, host: 'oe-vm', data_dir: '/srv/relay', owner: 'o@example.invalid', accounts: ['y@example.invalid'] } } }, db, 'teamsrelay', receipt);
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
