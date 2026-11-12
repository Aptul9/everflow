import { expect, test } from 'vitest';
import { createGchatState, scanOeGchat } from '../src/watchers/gchat.ts';
import { createGmailState, scanOeGmail, scanOeGmails } from '../src/watchers/gmail.ts';
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
const unnamedGroup = { group: { group_type: 'ROOM' } };
const message = (id: string, from = 'other', extra: Record<string, unknown> = {}) => ({ id, thread: 'topic', from_id: from, from, time: '2026-11-07T09:30:00Z', text: 'see https://x.invalid/a',
  reply: false, edited: false, deleted: false, attachments: [], items: [], reactions: [], ...extra });

test('Chat through the OE agent reads only active conversations, batched, with gweb annotation lines', async () => {
  const { sessions, call } = agent((path, body) => {
    expect(path).toBe('/api/communication/gchat/read');
    expect(body.account).toBe(account);
    if (body.action === 'list') return ok({ self_id: 'self', conversations, coverage: 'recent-conversations' });
    if (body.action === 'group') return ok(unnamedGroup);
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
    [{ action: 'group', conversation: 'space', kind: 'space', account }],
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

test('Chat keeps DMs, group chats and listed spaces whole, named spaces only for threads with a mention or own message, and never reads app DMs', async () => {
  const last = '2026-11-07T09:50:00Z';
  const listed = [
    { id: 'dm', kind: 'dm', name: 'Alberto', unread: 0, last }, { id: 'bot', kind: 'dm', name: 'Google Drive', unread: 0, last },
    { id: 'group', kind: 'space', name: 'group', unread: 0, last }, { id: 'big', kind: 'space', name: 'TechCare Support', unread: 0, last },
    { id: 'mine', kind: 'space', name: 'TMIT - Agente AI Area Vendita', unread: 0, last },
  ];
  const groups: Record<string, unknown> = { dm: { group: { group_type: 'HUMAN_DM' } }, bot: { group: { group_type: 'BOT_DM' } }, group: { group: { group_type: 'ROOM' } },
    big: { group: { group_type: 'ROOM', name: 'TechCare Support' } }, mine: { group: { group_type: 'ROOM', name: 'TMIT - Agente AI Area Vendita' } } };
  const at = (minute: number) => `2026-11-07T09:${String(minute).padStart(2, '0')}:00Z`;
  const reads: Record<string, unknown[]> = {
    dm: [message('d1', 'alberto', { time: at(10), text: 'ciao' }), message('d0', 'self', { from: 'ANTONIO MARITATO', time: at(11), text: 'ok' })],
    group: [message('g1', 'martina', { time: at(12), text: 'chi fa il frontend?' })],
    big: [message('b1', 'frederic', { thread: 't-noise', time: at(13), text: 'CodeQL KO on another repo' }),
      message('b2', 'frederic', { thread: 't-tag', time: at(14), text: 'Hi @Antonio Maritato can you check the pooler?' }),
      message('b3', 'letizia', { thread: 't-tag', time: at(15), text: 'same issue here' }),
      message('b4', 'alex', { thread: 't-mine', time: at(16), text: 'and the cron?' }), message('b5', 'self', { from: 'ANTONIO MARITATO', thread: 't-mine', time: at(17), text: 'moved to 07:00' })],
    mine: [message('m1', 'giovanni', { thread: 't-any', time: at(18), text: 'nuova build in UAT' })],
  };
  const { sessions, call } = agent((_, body) => {
    if (body.action === 'list') return ok({ self_id: 'self', conversations: listed });
    if (body.action === 'group') return ok(groups[body.conversation]);
    return ok({ self_id: 'self', messages: reads[body.conversation] });
  });
  const records: SourceRecord[] = [], state = createGchatState({ account, selfId: 'self', since, fullSpaces: ['tmit - agente ai area vendita'] });
  await scanOeGchat(oeGoogleRead(call, 'gchat', account, 8), state, (record) => records.push(record), () => now);
  expect(sessions.flat().filter((r) => (r.body as any).action === 'read').map((r) => (r.body as any).conversation)).toEqual(['dm', 'group', 'big', 'mine']);
  const kept = records.filter((record) => 'message_id' in record) as any[];
  expect(kept.map((record) => record.message_id)).toEqual(['dm/d1', 'dm/d0', 'group/g1', 'big/b2', 'big/b3', 'big/b4', 'big/b5', 'mine/m1']);
  expect(kept.filter((record) => record.ref.mentions_me).map((record) => record.message_id)).toEqual(['big/b2']);
  const groupCalls = sessions.flat().filter((r) => (r.body as any).action === 'group').length;
  await scanOeGchat(oeGoogleRead(call, 'gchat', account, 8), state, () => {}, () => now);
  expect(sessions.flat().filter((r) => (r.body as any).action === 'group').length).toBe(groupCalls);
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
    const { call } = agent((path, body) => body.action === 'group' && code !== 'oemail.response-json' ? ok(unnamedGroup) : answer(path, body));
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

test('several Gmail mailboxes through the OE agent share one checkpoint, written only once every mailbox is read', async () => {
  const other = 'other@example.invalid';
  for (const failing of [undefined, other]) {
    const { call } = agent((_, body) => {
      if (body.account === failing) return { status: 502, body: '{"errore":"x"}' };
      if (body.path === 'profile') return ok({ emailAddress: body.account });
      if (body.path.startsWith('messages?')) return ok({ messages: [{ id: body.account === account ? 'a1' : 'o1', threadId: 'thread' }] });
      return ok(mail(/^messages\/([^?]+)/.exec(body.path)![1]!));
    });
    const records: SourceRecord[] = [];
    const mailboxes = [account, other].map((name) => ({ read: oeGoogleRead(call, 'gmail', name, 50), state: createGmailState({ account: name, since }) }));
    const work = scanOeGmails(mailboxes, (record) => records.push(record), () => now);
    if (failing) {
      await expect(work).rejects.toThrow('oemail.http');
      expect(records.some((record) => 'checkpoint' in record)).toBe(false);
    } else {
      await work;
      expect(records.filter((record) => 'message_id' in record).map((record) => [(record as any).account, (record as any).message_id])).toEqual([[account, 'a1'], [other, 'o1']]);
      expect(records.filter((record) => 'checkpoint' in record)).toEqual([{ source: 'gmail', accounts: [account, other], checkpoint: '2026-11-07T10:00:00.000Z' }]);
    }
  }
});

test('OE reads split into SSH sessions of the batch size, in order', async () => {
  const { sessions, call } = agent((_, body) => ok({ n: body.n }));
  const out = await oeGoogleRead(call, 'gmail', account, 2)([1, 2, 3, 4, 5].map((n) => ({ n })));
  expect(out).toEqual([1, 2, 3, 4, 5].map((n) => ({ n })));
  expect(sessions.map((session) => session.length)).toEqual([2, 2, 1]);
});
