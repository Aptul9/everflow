import { expect, test } from 'vitest';
import { createGchatState, scanOeGchat } from '../src/watchers/gchat.ts';
import { createGmailState, scanOeGmail } from '../src/watchers/gmail.ts';
import { oeGoogleRead } from '../src/watchers/oe-google.ts';
import type { OeRequest } from '../src/watchers/oemail.ts';
import type { SourceRecord } from '../src/watchers/source.ts';

const account = 'me@example.invalid', since = '2026-11-07T09:00:00Z', now = '2026-11-07T10:00:00Z';
const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });

function agent(answer: (path: string, body: any) => { status: number; body: string }) {
  const sessions: OeRequest[][] = [];
  const call = async (requests: OeRequest[]) => { sessions.push(requests); return requests.map((request) => answer(request.path, request.body)); };
  return { sessions, call };
}

const conversations = [
  { id: 'space', kind: 'space', name: 'Support', unread: 1, last: '2026-11-07T09:30:00Z' },
  { id: 'old', kind: 'dm', name: 'Quiet', unread: 0, last: '2026-11-01T09:00:00Z' },
  { id: 'never', kind: 'space', name: 'Empty', unread: 0, last: '1970-01-01T00:00:00.000Z' },
];
const message = (id: string, from = 'other', extra: Record<string, unknown> = {}) => ({ id, thread: 'topic', from_id: from, from, time: '2026-11-07T09:30:00Z', text: 'see https://x.invalid/a',
  reply: false, edited: false, deleted: false, attachments: [], items: [], reactions: [], ...extra });

test('Chat through the OE agent reads only active conversations, batched, with gweb annotation lines', async () => {
  const { sessions, call } = agent((path, body) => {
    expect(path).toBe('/api/communication/gchat/read');
    expect(body.account).toBe(account);
    if (body.action === 'list') return ok({ self_id: 'self', conversations, coverage: 'recent-conversations' });
    return ok({ self_id: 'self', coverage: 'recent-topics', messages: [
      message('one', 'other', { attachments: [{ token: 't', name: 'error.txt', mime_type: 'text/plain' }],
        items: [{ url: { url: 'https://x.invalid/a' } }, { url: { url: 'https://jira.invalid/T-1' } }, { id: 'doc1', title: 'Plan', mimetype: 'application/vnd.google-apps.document' }] }),
      message('own', 'self'),
    ] });
  });
  const records: SourceRecord[] = [], state = createGchatState({ account, selfId: 'self', since, topics: 50 });
  await scanOeGchat(oeGoogleRead(call, 'gchat', account, 8), state, (record) => records.push(record), () => now);
  expect(sessions.map((session) => session.map((request) => request.body))).toEqual([
    [{ action: 'list', account }],
    [{ action: 'read', conversation: 'space', kind: 'space', topics: 50, account }],
  ]);
  expect(records.filter((record) => 'message_id' in record)).toMatchObject([
    { source: 'gchat', account, conversation_id: 'space', conversation_title: 'Support', message_id: 'space/one', sender_is_me: false, attachments: [{ name: 'error.txt' }],
      text: 'see https://x.invalid/a\nlink: https://jira.invalid/T-1\ndrive: Plan (application/vnd.google-apps.document) id=doc1', ref: { space: 'space', id: 'one', thread: 'topic' } },
    { source: 'gchat', message_id: 'space/own', sender_is_me: true },
  ]);
  expect(records.at(-1)).toMatchObject({ source: 'gchat', accounts: [account], coverage: 'recent-topics', checkpoint: '2026-11-07T09:00:00.000Z', observed_at: '2026-11-07T10:00:00.000Z' });
  const before = records.length;
  await scanOeGchat(oeGoogleRead(call, 'gchat', account, 8), state, (record) => records.push(record), () => now);
  expect(records.slice(before).filter((record) => 'message_id' in record)).toEqual([]);
});

test('Chat through the OE agent fails closed on another identity, a refused read or a malformed answer', async () => {
  const cases: [string, (path: string, body: any) => { status: number; body: string }][] = [
    ['gchat.account-mismatch', (_, body) => ok(body.action === 'list' ? { self_id: 'other', conversations } : { self_id: 'other', messages: [] })],
    ['gchat.account-mismatch', (_, body) => ok(body.action === 'list' ? { self_id: 'self', conversations } : { self_id: 'other', messages: [] })],
    ['oemail.http', (_, body) => body.action === 'list' ? ok({ self_id: 'self', conversations }) : { status: 409, body: '{"errore":"Google Chat session import required"}' }],
    ['gchat.response-shape', (_, body) => ok(body.action === 'list' ? { self_id: 'self', conversations } : { self_id: 'self', messages: [{ id: 'x' }] })],
    ['oemail.response-json', () => ({ status: 200, body: 'not json' })],
  ];
  for (const [code, answer] of cases) {
    const records: SourceRecord[] = [];
    const { call } = agent(answer);
    await expect(scanOeGchat(oeGoogleRead(call, 'gchat', account, 8), createGchatState({ account, selfId: 'self', since }), (record) => records.push(record), () => now)).rejects.toThrow(code);
    expect(records.some((record) => 'checkpoint' in record)).toBe(false);
  }
});

const mail = (id: string, labels = ['INBOX']) => ({ id, threadId: 'thread', internalDate: String(Date.parse('2026-11-07T09:30:00Z')), labelIds: labels,
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Other <other@example.invalid>' }, { name: 'Subject', value: 'Help' }], body: { data: Buffer.from('Plain è').toString('base64url') } } });

test('Gmail through the OE agent pages the list, batches message reads and checkpoints the scan start', async () => {
  const { sessions, call } = agent((path, body) => {
    expect(path).toBe('/api/communication/gmail/read');
    expect(body.account).toBe(account);
    if (body.path === 'profile') return ok({ emailAddress: account, messagesTotal: 2 });
    if (body.path.startsWith('messages?')) return ok(body.path.includes('pageToken=next') ? { messages: [{ id: 'm2', threadId: 'thread' }] } : { messages: [{ id: 'm1', threadId: 'thread' }], nextPageToken: 'next' });
    const id = /^messages\/([^?]+)\?format=full$/.exec(body.path)![1]!;
    return ok(mail(id, id === 'm2' ? ['SENT'] : ['INBOX']));
  });
  const records: SourceRecord[] = [], state = createGmailState({ account, since });
  await scanOeGmail(oeGoogleRead(call, 'gmail', account, 50), state, (record) => records.push(record), () => now);
  const paths = sessions.map((session) => session.map((request) => (request.body as { path: string }).path));
  expect(paths).toEqual([
    ['profile', `messages?q=${encodeURIComponent('{in:inbox in:sent} after:1794041880')}&maxResults=500`],
    [`messages?q=${encodeURIComponent('{in:inbox in:sent} after:1794041880')}&maxResults=500&pageToken=next`],
    ['messages/m1?format=full', 'messages/m2?format=full'],
  ]);
  expect(records.filter((record) => 'message_id' in record)).toMatchObject([
    { source: 'gmail', account, conversation_id: 'thread', message_id: 'm1', text: 'Plain è', sender_is_me: false },
    { source: 'gmail', message_id: 'm2', sender_is_me: true },
  ]);
  expect(records.at(-1)).toMatchObject({ source: 'gmail', accounts: [account], checkpoint: '2026-11-07T10:00:00.000Z' });
  expect(state.floor).toBe('2026-11-07T10:00:00.000Z');
});

test('Gmail through the OE agent never checkpoints another account, a refused read or a repeated page token', async () => {
  const cases: [string, (path: string, body: any) => { status: number; body: string }][] = [
    ['gmail.account-mismatch', (_, body) => ok(body.path === 'profile' ? { emailAddress: 'other@example.invalid' } : { messages: [] })],
    ['oemail.http', (_, body) => body.path === 'profile' ? ok({ emailAddress: account }) : { status: 502, body: '{"errore":"x"}' }],
    ['gmail.pagination-limit', (_, body) => ok(body.path === 'profile' ? { emailAddress: account } : { messages: [], nextPageToken: 'same' })],
    ['gmail.response-shape', (_, body) => ok(body.path === 'profile' ? { emailAddress: account } : body.path.startsWith('messages?') ? { messages: [{ id: 'm1', threadId: 'thread' }] } : { id: 'm1' })],
  ];
  for (const [code, answer] of cases) {
    const records: SourceRecord[] = [], state = createGmailState({ account, since });
    const { call } = agent(answer);
    await expect(scanOeGmail(oeGoogleRead(call, 'gmail', account, 50), state, (record) => records.push(record), () => now)).rejects.toThrow(code);
    expect(records.some((record) => 'checkpoint' in record)).toBe(false);
    expect(state.floor).toBe('2026-11-07T09:00:00.000Z');
  }
});

test('OE reads split into SSH sessions of the batch size, in order', async () => {
  const { sessions, call } = agent((_, body) => ok({ n: body.n }));
  const out = await oeGoogleRead(call, 'gmail', account, 2)([1, 2, 3, 4, 5].map((n) => ({ n })));
  expect(out).toEqual([1, 2, 3, 4, 5].map((n) => ({ n })));
  expect(sessions.map((session) => session.length)).toEqual([2, 2, 1]);
});
