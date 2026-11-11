import fs from 'node:fs';
import { expect, test } from 'vitest';
import { loadConfig } from '../src/core/config.ts';
import { openDb } from '../src/core/db.ts';
import { ingest, schedule, sourceStart } from '../src/core/ingest.ts';
import { createGchatState, scanGchat } from '../src/watchers/gchat.ts';
import { createGmailState, scanGmail } from '../src/watchers/gmail.ts';
import type { SourceRecord } from '../src/watchers/source.ts';
import { scratch } from './support.ts';
import { readState } from '../src/web/state.ts';

const account = 'me@example.invalid', since = '2026-11-07T09:00:00Z', now = '2026-11-07T10:00:00Z';
const conv = { id: 'space', name: 'Support', kind: 'space', last: now, unread: 2 };
const chat = (id = 'one', from = 'other') => ({ id, thread: 'topic', time: '2026-11-07T09:30:00Z', from_id: from, from: from, text: 'Need help', items: ['file: error.txt (text/plain)'] });
const mail = (id = 'm1', labels = ['INBOX']) => ({ id, threadId: 'thread', internalDate: String(Date.parse('2026-11-07T09:30:00Z')), labelIds: labels,
  payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Other <other@example.invalid>' }, { name: 'Subject', value: 'Help' }], parts: [
    { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: Buffer.from('<p>HTML</p>').toString('base64url') } }, { mimeType: 'text/plain', body: { data: Buffer.from('Plain è').toString('base64url') } }] },
    { mimeType: 'application/pdf', filename: 'file.pdf', body: { attachmentId: 'binary-not-fetched', size: 123 } },
  ] } });

test('Google Chat reads native ids with refresh disabled, validates self and reports limited coverage', async () => {
  const calls: string[][] = [], records: SourceRecord[] = [];
  const query = async (args: string[]) => { calls.push(args); return args[1] === 'ls' ? [conv] : { conversation: conv, self_id: 'self', messages: [chat(), chat('own', 'self')] }; };
  const state = createGchatState({ account, selfId: 'self', since, topics: 200 });
  await scanGchat(query, state, (record) => records.push(record), () => now);
  expect(calls.every((args) => args.includes('--no-refresh') && args.includes('--json'))).toBe(true);
  expect(calls.flat()).not.toContain('--yes');
  expect(records.filter((record) => 'message_id' in record)).toMatchObject([
    { source: 'gchat', account, conversation_id: 'space', message_id: 'space/one', sender_is_me: false, attachments: [{ name: 'error.txt' }] },
    { source: 'gchat', sender_is_me: true },
  ]);
  expect(records.at(-1)).toMatchObject({ source: 'gchat', coverage: 'recent-topics', checkpoint: '2026-11-07T09:00:00.000Z', observed_at: '2026-11-07T10:00:00.000Z' });
  const before = records.length;
  await scanGchat(query, state, (record) => records.push(record), () => now);
  expect(records.slice(before).filter((record) => 'message_id' in record)).toEqual([]);
});

test('Google Chat minimized refresh is explicit opt-in and never passes both refresh modes', async () => {
  const calls: string[][] = [];
  const query = async (args: string[]) => { calls.push(args); return args[1] === 'ls' ? [conv] : { conversation: conv, self_id: 'self', messages: [] }; };
  const state = createGchatState({ account, selfId: 'self', since, browserRefresh: true });
  await scanGchat(query, state, () => {}, () => now);
  expect(calls.every((args) => args.includes('--background-refresh') && !args.includes('--no-refresh'))).toBe(true);
});

test('Google Chat rejects changed identity and malformed responses without checkpoints', async () => {
  for (const response of [{ conversation: conv, self_id: 'wrong', messages: [chat()] }, { conversation: conv, self_id: 'self', messages: [{}] }, {}]) {
    const records: SourceRecord[] = [];
    await expect(scanGchat(async (args) => args[1] === 'ls' ? [conv] : response, createGchatState({ account, selfId: 'self', since }), (record) => records.push(record), () => now)).rejects.toThrow();
    expect(records.some((record) => 'checkpoint' in record)).toBe(false);
  }
});

test('Google Chat emits returned edits and tombstones but never resurrects deleted messages', async () => {
  const records: SourceRecord[] = [], state = createGchatState({ account, selfId: 'self', since });
  let raw = { ...chat(), edited: false, deleted: false };
  const query = async (args: string[]) => args[1] === 'ls' ? [conv] : { conversation: conv, self_id: 'self', messages: [raw] };
  await scanGchat(query, state, (record) => records.push(record), () => now);
  raw = { ...raw, text: 'Edited', edited: true };
  await scanGchat(query, state, (record) => records.push(record), () => now);
  raw = { ...raw, deleted: true };
  await scanGchat(query, state, (record) => records.push(record), () => now);
  raw = { ...raw, deleted: false };
  await scanGchat(query, state, (record) => records.push(record), () => now);
  const messages = records.filter((record) => 'message_id' in record);
  expect(messages).toHaveLength(3);
  expect(messages.at(-1)).toMatchObject({ text: '', attachments: [], ref: { deleted: true } });
});

test('Gmail converts HTML bodies and refuses unavailable external body data', async () => {
  for (const external of [false, true]) {
    const records: SourceRecord[] = [];
    const query = async (args: string[]) => {
      if (args[2] === 'getProfile') return { emailAddress: account };
      if (args[3] === 'list') return { messages: [{ id: 'm1', threadId: 'thread' }] };
      return { ...mail(), payload: { mimeType: 'text/html', headers: [{ name: 'From', value: account }], body: external ? { attachmentId: 'not-downloaded' } : { data: Buffer.from('<style>hidden</style><p>Visible &amp; safe</p><script>secret</script>').toString('base64url') } } };
    };
    const work = scanGmail(query, createGmailState({ account, since }), (record) => records.push(record), () => now);
    if (external) await expect(work).rejects.toThrow('gmail.body-unavailable');
    else {
      await work;
      expect(records.find((record) => 'message_id' in record)).toMatchObject({ text: 'Visible & safe', sender_is_me: true });
    }
  }
});

test('Gmail paginates Inbox/Sent, decodes MIME, keeps own replies and publishes complete checkpoint', async () => {
  const calls: { args: string[]; params: any }[] = [], records: SourceRecord[] = [];
  const query = async (args: string[]) => {
    const params = JSON.parse(args[args.indexOf('--params') + 1]!); calls.push({ args, params });
    if (args[2] === 'getProfile') return { emailAddress: account };
    if (args[3] === 'list') return params.pageToken ? { messages: [{ id: 'm2', threadId: 'thread' }] } : { messages: [{ id: 'm1', threadId: 'thread' }], nextPageToken: 'next' };
    return mail(params.id, params.id === 'm2' ? ['SENT'] : ['INBOX']);
  };
  await scanGmail(query, createGmailState({ account, since }), (record) => records.push(record), () => now);
  const listed = calls.filter((call) => call.args[3] === 'list');
  expect(listed).toHaveLength(2);
  expect(listed[0]!.params.q).toBe('{in:inbox in:sent} after:1794041880');
  expect(listed[1]!.params.pageToken).toBe('next');
  expect(calls.every((call) => ['getProfile', 'list', 'get'].some((method) => call.args.includes(method)))).toBe(true);
  expect(records.filter((record) => 'message_id' in record)).toMatchObject([
    { source: 'gmail', conversation_id: 'thread', text: 'Plain è', sender_is_me: false, attachments: [{ name: 'file.pdf', size: 123 }] },
    { source: 'gmail', sender_is_me: true },
  ]);
  expect(records.at(-1)).toMatchObject({ source: 'gmail', accounts: [account], checkpoint: '2026-11-07T10:00:00.000Z' });
});

test('Gmail failed later page and authentication mismatch never acknowledge coverage', async () => {
  for (const mode of ['page', 'account', 'malformed', 'cycle']) {
    const records: SourceRecord[] = [];
    const query = async (args: string[]) => {
      if (args[2] === 'getProfile') return { emailAddress: mode === 'account' ? 'someone@example.invalid' : account };
      const params = JSON.parse(args[args.indexOf('--params') + 1]!);
      if (args[3] === 'list') {
        if (mode === 'malformed') return { messages: [{}] };
        if (params.pageToken && mode !== 'cycle') throw new Error('later page failed');
        return { messages: [{ id: 'm1', threadId: 'thread' }], nextPageToken: 'next' };
      }
      return mail();
    };
    await expect(scanGmail(query, createGmailState({ account, since }), (record) => records.push(record), () => now)).rejects.toThrow();
    expect(records.some((record) => 'checkpoint' in record)).toBe(false);
  }
});

test('new sources traverse SQLite ingest, replay deduplication and own-only batching without live activation', async () => {
  const f = scratch('google-pipeline-');
  fs.appendFileSync(f.config, '\n[tickets]\nenabled = true\n');
  const cfg = loadConfig(f.config);
  expect(cfg.windows).toMatchObject({ gchat: 120, gmail: 300 });
  using db = openDb(f.path);
  for (const source of ['gchat', 'gmail']) sourceStart(db, cfg, source, now);
  const records: SourceRecord[] = [];
  await scanGchat(async (args) => args[1] === 'ls' ? [conv] : { conversation: conv, self_id: 'self', messages: [chat('own', 'self')] }, createGchatState({ account, selfId: 'self', since }), (record) => records.push(record), () => now);
  await scanGmail(async (args) => args[2] === 'getProfile' ? { emailAddress: account } : args[3] === 'list' ? { messages: [{ id: 'm1', threadId: 'thread' }] } : mail(), createGmailState({ account, since }), (record) => records.push(record), () => now);
  for (let replay = 0; replay < 2; replay++) for (const record of records) ingest(db, JSON.parse(JSON.stringify(record)));
  expect(db.prepare('SELECT count(*) AS n FROM message').get()!.n).toBe(2);
  expect(schedule(db, cfg, now)).toHaveLength(1);
  expect(db.prepare("SELECT outcome FROM batch WHERE outcome='answered'").get()).toBeDefined();
  expect(db.prepare("SELECT detail FROM health WHERE dependency='gchat'").get()!.detail).toContain('recent-topics');
});

test('Google Chat limited coverage reaches the overview API instead of being hidden in SQLite', () => {
  const f = scratch('google-coverage-api-'), cfg = loadConfig(f.config);
  using db = openDb(f.path);
  sourceStart(db, cfg, 'gchat', since);
  ingest(db, { source: 'gchat', accounts: [account] });
  ingest(db, { source: 'gchat', accounts: [account], checkpoint: since, observed_at: now, coverage: 'recent-topics' });
  expect(readState(db, cfg).health.find((item) => item.dependency === 'gchat')).toMatchObject({ coverage: 'recent-topics', observed_at: '2026-11-07T10:00:00.000000Z' });
});
