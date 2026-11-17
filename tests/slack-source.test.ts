import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, vi } from 'vitest';
import { createSlackState, httpSlackCall, scanSlack, slackMain } from '../src/watchers/slack.ts';
import type { SlackRequest } from '../src/watchers/slack.ts';
import type { SourceRecord } from '../src/watchers/source.ts';

const account = 'me@example.invalid', since = '2026-11-07T09:00:00Z', now = '2026-11-07T10:00:00Z';
const at = (iso: string) => (Date.parse(iso) / 1000).toFixed(6);
const T1 = at('2026-11-07T09:30:00Z'), T2 = at('2026-11-07T09:40:00Z'), OLD = at('2026-11-01T09:00:00Z'), REPLY = at('2026-11-07T09:45:00Z'), PARENT = at('2026-11-06T09:00:00Z'), UPDATED = at('2026-11-07T09:50:00Z');

function slack(overrides: Partial<Record<string, (params: Record<string, string>) => unknown>> = {}) {
  const sessions: SlackRequest[][] = [];
  const answers: Record<string, (params: Record<string, string>) => unknown> = {
    'auth.test': () => ({ ok: true, user_id: 'UME', team_id: 'TTEAM' }),
    'client.counts': () => ({ ok: true, channels: [{ id: 'C1', latest: T2 }, { id: 'COLD', latest: OLD }, { id: 'CTH', latest: PARENT, updated: UPDATED }, { id: 'CNOISE', latest: T2 }], mpims: [{ id: 'G1', latest: T2 }], ims: [{ id: 'D1', latest: T1 }, { id: 'D0', latest: '0000000000.000000' }] }),
    'subscriptions.thread.getView': () => ({ ok: true, threads: [{ root_msg: { channel: 'COLD', ts: OLD, latest_reply: REPLY } }] }),
    'conversations.history': (p) => ({ ok: true, messages: p.channel === 'C1'
      ? [{ ts: T2, user: 'UOTHER', text: 'hi <@UME> see <https://x.invalid|doc> &amp; <#C2|ops> <!subteam^S1> <!date^1794441600^{date_long}|Thursday> <slack://user?id=U9|@Mia>', files: [{ name: 'log.txt', size: 12 }] }, { ts: T1, subtype: 'channel_join', user: 'UNEW', text: 'joined' }]
      : p.channel === 'CTH' ? [{ ts: PARENT, user: 'UOTHER', text: 'parent', reply_count: 2, latest_reply: REPLY }]
      : p.channel === 'CNOISE' ? [{ ts: T2, user: 'UOTHER', text: 'standup moved to 10' }]
      : p.channel === 'G1' ? [{ ts: T2, user: 'UOTHER', text: 'group hello' }]
      : [{ ts: T1, user: 'UME', text: 'own note' }] }),
    'conversations.replies': (p) => ({ ok: true, messages: [{ ts: p.ts, user: 'UOTHER', text: 'old root' }, { ts: REPLY, thread_ts: p.ts, user: 'UOTHER', text: p.channel === 'CTH' ? 'late reply for <@UME>' : 'late reply' }] }),
    'conversations.info': (p) => ({ ok: true, channel: p.channel!.startsWith('D') ? { id: p.channel, is_im: true, user: 'UOTHER' } : p.channel === 'G1' ? { id: p.channel, is_mpim: true, name: 'mpdm-me--other-1' } : { id: p.channel, name: p.channel === 'C1' ? 'support' : 'archive' } }),
    'users.info': (p) => ({ ok: true, user: { id: p.user, real_name: p.user === 'UME' ? 'Me' : 'Other Person', profile: p.user === 'UOTHER' ? { email: 'Other@Example.invalid' } : {} } }),
    ...overrides,
  };
  const call = async (requests: SlackRequest[]) => { sessions.push(requests); return requests.map((r) => answers[r.method]!(r.params ?? {})); };
  return { sessions, call };
}

test('Slack reads DMs and group DMs whole, channels only for threads that tag the user, that he wrote in or follows, newer than the floor', async () => {
  const { sessions, call } = slack();
  const records: SourceRecord[] = [], state = createSlackState({ account, selfId: 'UME', workspace: 'TTEAM', since });
  await scanSlack(call, state, (record) => records.push(record), () => now);
  const methods = sessions.map((session) => session.map((r) => `${r.method} ${r.params?.channel ?? ''}`.trim()));
  expect(methods[0]).toEqual(['auth.test', 'client.counts', 'subscriptions.thread.getView']);
  expect(methods[1]).toEqual(['conversations.history C1', 'conversations.history CTH', 'conversations.history CNOISE', 'conversations.history G1', 'conversations.history D1']);
  expect(methods[2]).toEqual(['conversations.replies COLD', 'conversations.replies CTH']);
  expect(sessions[1]![0]!.params!.oldest).toBe(at('2026-11-04T08:58:00Z'));
  expect(records.filter((r) => 'message_id' in r)).toMatchObject([
    { source: 'slack', conversation_id: 'D1', conversation_title: 'Other Person', message_id: 'D1/' + T1, sender_is_me: true, text: 'own note' },
    { source: 'slack', conversation_id: 'C1', conversation_title: '#support', sender: 'other@example.invalid', sender_name: 'Other Person', sender_is_me: false,
      text: 'hi @Me see doc (https://x.invalid) & #ops @group Thursday @Mia', attachments: [{ name: 'log.txt', size: 12 }], ref: { channel: 'C1', ts: T2, mentions_me: true, workspace: 'TTEAM' } },
    { source: 'slack', conversation_id: 'G1', conversation_title: 'mpdm-me--other-1', text: 'group hello' },
    { source: 'slack', conversation_id: 'COLD', conversation_title: '#archive', text: 'late reply', ref: { thread_ts: OLD } },
    { source: 'slack', conversation_id: 'CTH', text: 'late reply for @Me', ref: { thread_ts: PARENT, mentions_me: true } },
  ]);
  expect(records.at(-1)).toEqual({ source: 'slack', accounts: [account], checkpoint: '2026-11-07T10:00:00.000Z' });
  expect(state.floor).toBe('2026-11-07T10:00:00.000Z');
  const before = records.length, calls = sessions.length;
  await scanSlack(call, state, (record) => records.push(record), () => '2026-11-07T10:01:00Z');
  expect(sessions.length - calls).toBe(1);
  expect(records.slice(before).filter((r) => 'message_id' in r)).toEqual([]);
});

test('Slack fails closed on another user or team and on malformed answers, without a checkpoint', async () => {
  for (const overrides of [
    { 'auth.test': () => ({ ok: true, user_id: 'USOMEONE', team_id: 'TTEAM' }) },
    { 'auth.test': () => ({ ok: true, user_id: 'UME', team_id: 'TOTHER' }) },
    { 'conversations.history': () => ({ ok: true, messages: [{ text: 'no ts' }] }) },
  ]) {
    const records: SourceRecord[] = [], state = createSlackState({ account, selfId: 'UME', workspace: 'TTEAM', since });
    await expect(scanSlack(slack(overrides).call, state, (record) => records.push(record), () => now)).rejects.toThrow(/slack\./);
    expect(records.some((r) => 'checkpoint' in r)).toBe(false);
    expect(state.floor).toBe('2026-11-07T09:00:00.000Z');
  }
});

test('slack state refuses a user id that is not one', () => {
  expect(() => createSlackState({ account, selfId: 'not-a-user', workspace: 'TTEAM', since })).toThrow('slack.invalid-options');
});

const TOKEN = 'everflow-token-0123456789abcdef0123456789';

async function endpoint(answer: (request: SlackRequest) => { status: number; body: string }) {
  const seen: { url: string; auth: string; body: { workspace: string; requests: SlackRequest[] } }[] = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const body = JSON.parse(text);
      seen.push({ url: req.url!, auth: req.headers.authorization!, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ responses: body.requests.map(answer) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

test('httpSlackCall posts the workspace and requests to /everflow/slack and parses each answer', async () => {
  const oe = await endpoint((r) => ({ status: 200, body: JSON.stringify({ ok: true, method: r.method }) }));
  try {
    const call = httpSlackCall({ url: oe.url, token: TOKEN }, 'T0250U10X');
    const requests: SlackRequest[] = [{ method: 'auth.test' }, { method: 'conversations.history', params: { channel: 'C1', oldest: '1.0' } }];
    expect(await call(requests)).toEqual([{ ok: true, method: 'auth.test' }, { ok: true, method: 'conversations.history' }]);
    expect(oe.seen).toEqual([{ url: '/everflow/slack', auth: `Bearer ${TOKEN}`, body: { workspace: 'T0250U10X', requests } }]);
  } finally { oe.close(); }
});

test('httpSlackCall: ok false is slack.api with method:error, a 429 passes through as slack.api 429, non-JSON is slack.response-json', async () => {
  const cases: [{ status: number; body: string }, Record<string, unknown>][] = [
    [{ status: 200, body: '{"ok":false,"error":"invalid_auth"}' }, { code: 'slack.api', status: 400, reason: 'conversations.history:invalid_auth' }],
    [{ status: 429, body: '{"ok":false,"error":"ratelimited"}' }, { code: 'slack.api', status: 429, reason: 'conversations.history:ratelimited' }],
    [{ status: 502, body: '<html>' }, { code: 'slack.response-json', status: 502 }],
  ];
  for (const [answer, expected] of cases) {
    const oe = await endpoint(() => answer);
    try {
      await expect(httpSlackCall({ url: oe.url, token: TOKEN }, 'T0250U10X')([{ method: 'conversations.history', params: { channel: 'C1' } }])).rejects.toMatchObject(expected);
    } finally { oe.close(); }
  }
});

test('httpSlackCall sends at most 25 requests per call and refuses anything but read methods before any call', async () => {
  const oe = await endpoint((r) => ({ status: 200, body: JSON.stringify({ ok: true, user: { id: r.params!.user } }) }));
  try {
    const call = httpSlackCall({ url: oe.url, token: TOKEN }, 'T0250U10X');
    const requests = Array.from({ length: 26 }, (_, i) => ({ method: 'users.info', params: { user: `U${i}` } }));
    expect(await call(requests)).toHaveLength(26);
    expect(oe.seen.map((s) => s.body.requests.length)).toEqual([25, 1]);
    oe.seen.length = 0;
    await expect(call([{ method: 'auth.test' }, { method: 'chat.postMessage' }])).rejects.toMatchObject({ code: 'slack.invalid-argument' });
    expect(() => httpSlackCall({ url: oe.url, token: TOKEN }, 'not-a-team')).toThrow('slack.invalid-argument');
    expect(oe.seen).toEqual([]);
  } finally { oe.close(); }
});

test('the slack watcher takes the endpoint from its environment and no longer knows --host or --store', async () => {
  const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    vi.stubEnv('EVERFLOW_OE_URL', ''); vi.stubEnv('EVERFLOW_OE_TOKEN', TOKEN);
    const args = ['--since', since, '--once', '--account', account, '--self-id', 'UME', '--workspace', 'T0250U10X'];
    await expect(slackMain(args)).rejects.toMatchObject({ code: 'slack.oe-config' });
    await expect(slackMain([...args, '--host', 'oe-vm'])).rejects.toThrow();
    await expect(slackMain([...args, '--store', '/x'])).rejects.toThrow();
  } finally { errors.mockRestore(); vi.unstubAllEnvs(); }
});
