import { expect, test } from 'vitest';
import { createSlackState, scanSlack, slackCommand } from '../src/watchers/slack.ts';
import type { SlackRequest } from '../src/watchers/slack.ts';
import type { SourceRecord } from '../src/watchers/source.ts';

const account = 'me@example.invalid', since = '2026-11-07T09:00:00Z', now = '2026-11-07T10:00:00Z';
const at = (iso: string) => (Date.parse(iso) / 1000).toFixed(6);
const T1 = at('2026-11-07T09:30:00Z'), T2 = at('2026-11-07T09:40:00Z'), OLD = at('2026-11-01T09:00:00Z'), REPLY = at('2026-11-07T09:45:00Z');

function slack(overrides: Partial<Record<string, (params: Record<string, string>) => unknown>> = {}) {
  const sessions: SlackRequest[][] = [];
  const answers: Record<string, (params: Record<string, string>) => unknown> = {
    'auth.test': () => ({ ok: true, user_id: 'UME', team_id: 'TTEAM' }),
    'client.counts': () => ({ ok: true, channels: [{ id: 'C1', latest: T2 }, { id: 'COLD', latest: OLD }], mpims: [], ims: [{ id: 'D1', latest: T1 }, { id: 'D0', latest: '0000000000.000000' }] }),
    'subscriptions.thread.getView': () => ({ ok: true, threads: [{ root_msg: { channel: 'COLD', ts: OLD, latest_reply: REPLY } }] }),
    'conversations.history': (p) => ({ ok: true, messages: p.channel === 'C1'
      ? [{ ts: T2, user: 'UOTHER', text: 'hi <@UME> see <https://x.invalid|doc> &amp; <#C2|ops> <!subteam^S1> <!date^1794441600^{date_long}|Thursday> <slack://user?id=U9|@Mia>', files: [{ name: 'log.txt', size: 12 }] }, { ts: T1, subtype: 'channel_join', user: 'UNEW', text: 'joined' }]
      : [{ ts: T1, user: 'UME', text: 'own note' }] }),
    'conversations.replies': (p) => ({ ok: true, messages: [{ ts: p.ts, user: 'UOTHER', text: 'old root' }, { ts: REPLY, thread_ts: p.ts, user: 'UOTHER', text: 'late reply' }] }),
    'conversations.info': (p) => ({ ok: true, channel: p.channel!.startsWith('D') ? { id: p.channel, is_im: true, user: 'UOTHER' } : { id: p.channel, name: p.channel === 'C1' ? 'support' : 'archive' } }),
    'users.info': (p) => ({ ok: true, user: { id: p.user, real_name: p.user === 'UME' ? 'Me' : 'Other Person', profile: p.user === 'UOTHER' ? { email: 'Other@Example.invalid' } : {} } }),
    ...overrides,
  };
  const call = async (requests: SlackRequest[]) => { sessions.push(requests); return requests.map((r) => answers[r.method]!(r.params ?? {})); };
  return { sessions, call };
}

test('Slack reads only conversations and threads newer than the floor, resolves names and flags mentions', async () => {
  const { sessions, call } = slack();
  const records: SourceRecord[] = [], state = createSlackState({ account, selfId: 'UME', workspace: 'TTEAM', since });
  await scanSlack(call, state, (record) => records.push(record), () => now);
  const methods = sessions.map((session) => session.map((r) => `${r.method} ${r.params?.channel ?? ''}`.trim()));
  expect(methods[0]).toEqual(['auth.test', 'client.counts', 'subscriptions.thread.getView']);
  expect(methods[1]).toEqual(['conversations.history C1', 'conversations.history D1']);
  expect(methods[2]).toEqual(['conversations.replies COLD']);
  expect(sessions[1]![0]!.params!.oldest).toBe(at('2026-11-07T08:58:00Z'));
  expect(records.filter((r) => 'message_id' in r)).toMatchObject([
    { source: 'slack', conversation_id: 'D1', conversation_title: 'Other Person', message_id: 'D1/' + T1, sender_is_me: true, text: 'own note' },
    { source: 'slack', conversation_id: 'C1', conversation_title: '#support', sender: 'other@example.invalid', sender_name: 'Other Person', sender_is_me: false,
      text: 'hi @Me see doc (https://x.invalid) & #ops @group Thursday @Mia', attachments: [{ name: 'log.txt', size: 12 }], ref: { channel: 'C1', ts: T2, mentions_me: true, workspace: 'TTEAM' } },
    { source: 'slack', conversation_id: 'COLD', conversation_title: '#archive', text: 'late reply', ref: { thread_ts: OLD } },
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

test('the remote Slack command allows only read methods and carries requests as base64', () => {
  const command = slackCommand('T0250U10X', [{ method: 'conversations.history', params: { channel: "C1'; rm -rf /", oldest: '1.0' } }]);
  expect(command).toMatch(/^bash -c "\$\(printf %s '[A-Za-z0-9+/=]+' \| base64 -d\)"$/);
  expect(command).not.toContain('rm -rf');
  expect(() => slackCommand('T0250U10X', [{ method: 'chat.postMessage' }])).toThrow('slack.invalid-argument');
  expect(() => slackCommand('not-a-team', [{ method: 'auth.test' }])).toThrow('slack.invalid-argument');
  expect(() => slackCommand('T0250U10X', [{ method: 'auth.test' }], "/x'; y")).toThrow('slack.invalid-argument');
  expect(() => createSlackState({ account, selfId: 'not-a-user', workspace: 'TTEAM', since })).toThrow('slack.invalid-options');
});
