import { expect, test } from 'vitest';
import { createOeMailState, nextPath, oeCommand, parseOeOutput, scanOeMail } from '../src/watchers/oemail.ts';
import type { OeCall, OeRequest } from '../src/watchers/oemail.ts';
import type { SourceRecord } from '../src/watchers/source.ts';

const MSC = 'me@msc.invalid', NPO = 'me@notarify.invalid';
const NOW = '2026-11-10T18:00:00.000Z';

function mail(id: string, extra: Record<string, unknown> = {}) {
  return { Id: `rest-${id}`, InternetMessageId: `<${id}@mail>`, Subject: `Subject ${id}`, From: { EmailAddress: { Name: 'Keivan', Address: 'Keivan@MSC.invalid' } },
    ReceivedDateTime: '2026-11-10T17:27:32Z', ConversationId: `conv-${id}`, HasAttachments: false, IsDraft: false,
    UniqueBody: { ContentType: 'HTML', Content: '<html><body><p>Hello <b>team</b></p><style>p{}</style></body></html>' }, ...extra };
}

function fake(statuses: Record<string, string>, pages: Record<string, unknown[][]>) {
  const calls: OeRequest[][] = [];
  const call: OeCall = async (requests) => {
    calls.push(requests);
    return requests.map((request) => {
      if (request.path === '/api/communication/accounts') return { status: 200, body: JSON.stringify({ accounts: Object.entries(statuses).map(([upn, status]) => ({ upn, status })) }) };
      const { account, path } = request.body as { account: string; path: string };
      const folder = /MailFolders\/(\w+)/.exec(path)![1]!;
      const list = pages[`${account}:${folder}`] ?? [];
      const index = Number(/%24skip=(\d+)/.exec(path)?.[1] ?? 0);
      const value = list[index] ?? [];
      return { status: 200, body: JSON.stringify({ value, ...(index + 1 < list.length ? { '@odata.nextLink': `https://outlook.office.com/api/v2.0/me/MailFolders/${folder}/messages?%24skip=${index + 1}` } : {}) }) };
    });
  };
  return { call, calls };
}

test('reads inbox and sent of each listed mailbox, keys by internet message id and checkpoints all accounts', async () => {
  const { call, calls } = fake({ [MSC]: 'ok', [NPO]: 'ok', 'other@x.invalid': 'ok' }, {
    [`${MSC}:Inbox`]: [[mail('a')], [mail('b', { IsDraft: true }), mail('c')]],
    [`${NPO}:SentItems`]: [[mail('d', { From: { EmailAddress: { Name: 'Me', Address: NPO } } })]],
  });
  const records: SourceRecord[] = [];
  const state = createOeMailState({ accounts: [NPO, MSC], since: '2026-11-10T17:00:00Z' });
  await scanOeMail(call, state, (record) => records.push(record), () => NOW);
  const messages = records.filter((record) => 'message_id' in record) as Extract<SourceRecord, { message_id: string }>[];
  expect(messages.map((record) => [record.account, record.message_id, record.sender_is_me])).toEqual([
    [MSC, '<a@mail>', false], [NPO, '<d@mail>', true], [MSC, '<c@mail>', false]]);
  expect(messages[0]).toMatchObject({ source: 'oemail', conversation_id: 'conv-a', conversation_title: 'Subject a', sender: 'keivan@msc.invalid', sender_name: 'Keivan',
    sent_at: '2026-11-10T17:27:32.000Z', ref: { account: MSC, id: 'rest-a', folder: 'Inbox' } });
  expect(messages[0]!.text).toContain('Hello');
  expect(messages[0]!.text).not.toContain('<');
  expect(records.at(-1)).toEqual({ source: 'oemail', accounts: [MSC, NPO], checkpoint: NOW });
  const reads = calls.flat().filter((request) => request.path === '/api/communication/read').map((request) => (request.body as { account: string }).account);
  expect(new Set(reads)).toEqual(new Set([MSC, NPO]));
  expect(String((calls[1]![0]!.body as { path: string }).path)).toContain('ReceivedDateTime%20ge%202026-11-10T16%3A58%3A00Z');
  expect(state.floor).toBe(NOW);
});

test('an unavailable mailbox keeps its own floor: the checkpoint stays at it, names it failed, the others still emit and advance', async () => {
  const { call } = fake({ [MSC]: 'ok', [NPO]: 'errore' }, { [`${MSC}:Inbox`]: [[mail('a')]] });
  const records: SourceRecord[] = [], reported: unknown[] = [];
  const state = createOeMailState({ accounts: [MSC, NPO], since: '2026-11-10T17:00:00Z' });
  await scanOeMail(call, state, (record) => records.push(record), () => NOW, undefined, (error) => reported.push(error));
  expect(records.filter((record) => 'message_id' in record)).toHaveLength(1);
  expect(records.at(-1)).toEqual({ source: 'oemail', accounts: [MSC, NPO], checkpoint: '2026-11-10T17:00:00.000Z', failed: [NPO] });
  expect(reported).toEqual([expect.objectContaining({ code: 'oemail.account-unavailable', account: NPO, reason: 'errore' })]);
  expect(state.floors.get(MSC)).toBe(NOW);
  expect(state.floor).toBe('2026-11-10T17:00:00.000Z');
});

test('a failed read sets only that mailbox aside, reports it once, and it catches up from its own floor when it recovers', async () => {
  let broken = true;
  const listed: Record<string, string[]> = {};
  const call: OeCall = async (requests) => requests.map((request) => {
    if (request.path === '/api/communication/accounts') return { status: 200, body: JSON.stringify({ accounts: [{ upn: MSC, status: 'ok' }, { upn: NPO, status: 'ok' }] }) };
    const { account, path } = request.body as { account: string; path: string };
    (listed[account] ??= []).push(decodeURIComponent(path));
    if (account === NPO && broken) return { status: 502, body: '{"errore":"x"}' };
    return { status: 200, body: JSON.stringify({ value: path.includes('Inbox') ? [mail(account === MSC ? 'm' : 'n')] : [] }) };
  });
  const records: SourceRecord[] = [], reported: unknown[] = [];
  const state = createOeMailState({ accounts: [MSC, NPO], since: '2026-11-10T17:00:00Z' });
  const scan = (at: string) => scanOeMail(call, state, (record) => records.push(record), () => at, undefined, (error) => reported.push(error));
  await scan(NOW);
  await scan('2026-11-10T18:01:00.000Z');
  expect(records.filter((record) => 'message_id' in record).map((record) => (record as { account: string }).account)).toEqual([MSC]);
  expect(records.filter((record) => 'checkpoint' in record)).toEqual([
    { source: 'oemail', accounts: [MSC, NPO], checkpoint: '2026-11-10T17:00:00.000Z', failed: [NPO] },
    { source: 'oemail', accounts: [MSC, NPO], checkpoint: '2026-11-10T17:00:00.000Z', failed: [NPO] }]);
  expect(reported).toEqual([expect.objectContaining({ code: 'oemail.http', account: NPO, status: 502 })]);
  expect(listed[MSC]!.at(-1)).toContain('ge 2026-11-10T17:58:00Z');
  broken = false;
  await scan('2026-11-10T18:02:00.000Z');
  expect(listed[NPO]!.at(-1)).toContain('ge 2026-11-10T16:58:00Z');
  expect(records.filter((record) => 'message_id' in record).map((record) => (record as { account: string }).account)).toEqual([MSC, NPO]);
  expect(records.at(-1)).toEqual({ source: 'oemail', accounts: [MSC, NPO], checkpoint: '2026-11-10T18:02:00.000Z' });
  expect(reported).toHaveLength(1);
});

test('a failure that names no account still fails the whole scan', async () => {
  const call: OeCall = async () => [{ status: 503, body: '' }];
  await expect(scanOeMail(call, createOeMailState({ accounts: [MSC], since: NOW }), () => {}, () => NOW)).rejects.toMatchObject({ code: 'oemail.http', status: 503 });
});

test('next links become gateway paths; the remote command carries requests only as base64', () => {
  expect(nextPath('https://outlook.office.com/api/v2.0/me/MailFolders/Inbox/messages?%24skip=50')).toBe('me/MailFolders/Inbox/messages?%24skip=50');
  expect(() => nextPath('https://example.invalid/other')).toThrow('oemail.pagination');
  const command = oeCommand([{ path: '/api/communication/read', body: { account: MSC, path: "x'; rm -rf /" } }]);
  expect(command).toMatch(/^bash -c "\$\(printf %s '[A-Za-z0-9+/=]+' \| base64 -d\)"$/);
  expect(command).not.toContain('rm -rf /');
  // one line per request: status and base64 body; anything else is a shape error
  expect(parseOeOutput(`200 ${Buffer.from('{"a":1}').toString('base64')}\n404 \n`, 2)).toEqual([{ status: 200, body: '{"a":1}' }, { status: 404, body: '' }]);
  expect(() => parseOeOutput('200 e30=\n', 2)).toThrow('oemail.response-shape');
  expect(() => parseOeOutput('ok {}\n', 1)).toThrow('oemail.response-shape');
  expect(() => createOeMailState({ accounts: [], since: NOW })).toThrow('oemail.account-required');
});
