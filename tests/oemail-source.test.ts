import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, vi } from 'vitest';
import { createOeMailState, httpOeCall, nextPath, oeMailMain, scanOeMail } from '../src/watchers/oemail.ts';
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

test('mail from others records where the mailbox stood: to, cc, or other for a distribution list; own mail carries none', async () => {
  const to = (...addresses: string[]) => addresses.map((address) => ({ EmailAddress: { Name: address, Address: address } }));
  const { call, calls } = fake({ [MSC]: 'ok' }, {
    [`${MSC}:Inbox`]: [[mail('to', { ToRecipients: to('someone@msc.invalid', 'ME@msc.invalid') }), mail('cc', { ToRecipients: to('cloud@msc.invalid'), CcRecipients: to(MSC) }),
      mail('dl', { ToRecipients: to('dl-requests@msc.invalid'), CcRecipients: null })]],
    [`${MSC}:SentItems`]: [[mail('own', { From: { EmailAddress: { Name: 'Me', Address: MSC } }, ToRecipients: to('cloud@msc.invalid') })]],
  });
  const records: SourceRecord[] = [];
  await scanOeMail(call, createOeMailState({ accounts: [MSC], since: '2026-11-10T17:00:00Z' }), (record) => records.push(record), () => NOW);
  const refs = Object.fromEntries((records.filter((record) => 'message_id' in record) as Extract<SourceRecord, { message_id: string }>[])
    .map((record) => [record.message_id, record.ref?.addressed ?? null]));
  expect(refs).toEqual({ '<to@mail>': 'to', '<cc@mail>': 'cc', '<dl@mail>': 'other', '<own@mail>': null });
  expect(decodeURIComponent(String((calls[1]![0]!.body as { path: string }).path))).toContain('ToRecipients,CcRecipients');
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

test('next links become gateway paths', () => {
  expect(nextPath('https://outlook.office.com/api/v2.0/me/MailFolders/Inbox/messages?%24skip=50')).toBe('me/MailFolders/Inbox/messages?%24skip=50');
  expect(() => nextPath('https://example.invalid/other')).toThrow('oemail.pagination');
  expect(() => createOeMailState({ accounts: [], since: NOW })).toThrow('oemail.account-required');
});

async function endpoint(answer: (body: any) => unknown) {
  const seen: { url: string; auth: string; body: any }[] = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const body = JSON.parse(text);
      seen.push({ url: req.url!, auth: req.headers.authorization!, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

test('httpOeCall posts the requests to /everflow/agent and returns the responses in order', async () => {
  const oe = await endpoint((body) => ({ responses: body.requests.map((r: { path: string }, i: number) => ({ status: i === 1 ? 502 : 200, body: `${i}:${r.path}` })) }));
  try {
    const call = httpOeCall({ url: oe.url, token: 'everflow-token-0123456789abcdef0123456789' });
    const requests: OeRequest[] = [{ path: '/api/communication/accounts' }, { path: '/api/communication/read', body: { account: MSC, path: 'me/MailFolders/Inbox/messages' } }];
    expect(await call(requests)).toEqual([{ status: 200, body: '0:/api/communication/accounts' }, { status: 502, body: '1:/api/communication/read' }]);
    expect(oe.seen).toEqual([{ url: '/everflow/agent', auth: 'Bearer everflow-token-0123456789abcdef0123456789', body: { requests } }]);
  } finally { oe.close(); }
});

test('httpOeCall refuses an answer of the wrong length or shape as oemail.response-shape, under the caller source', async () => {
  for (const answer of [{ responses: [] }, { responses: [{ status: '200', body: '' }] }, { responses: [{ status: 200 }] }, { other: true }]) {
    const oe = await endpoint(() => answer);
    try {
      await expect(httpOeCall({ url: oe.url, token: 'everflow-token-0123456789abcdef0123456789' }, 'gmail')([{ path: '/api/communication/accounts' }]))
        .rejects.toMatchObject({ code: 'oemail.response-shape', source: 'gmail' });
    } finally { oe.close(); }
  }
});

test('the oemail watcher reads through the endpoint in its environment, and without it fails oemail.oe-config', async () => {
  const oe = await endpoint((body) => ({ responses: body.requests.map((r: OeRequest) => r.path === '/api/communication/accounts'
    ? { status: 200, body: JSON.stringify({ accounts: [{ upn: MSC, status: 'ok' }] }) } : { status: 200, body: JSON.stringify({ value: [] }) }) }));
  const out: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  const errors = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  try {
    vi.stubEnv('EVERFLOW_OE_URL', oe.url); vi.stubEnv('EVERFLOW_OE_TOKEN', 'everflow-token-0123456789abcdef0123456789');
    expect(await oeMailMain(['--since', '2026-11-10T17:00:00Z', '--once', '--account', MSC])).toBe(0);
    expect(oe.seen.map((s) => s.body.requests[0].path)).toEqual(['/api/communication/accounts', '/api/communication/read']);
    expect(out.some((line) => line.includes('"checkpoint"'))).toBe(true);
    vi.stubEnv('EVERFLOW_OE_TOKEN', '');
    await expect(oeMailMain(['--since', '2026-11-10T17:00:00Z', '--once', '--account', MSC])).rejects.toMatchObject({ code: 'oemail.oe-config' });
    await expect(oeMailMain(['--since', '2026-11-10T17:00:00Z', '--once', '--account', MSC, '--host', 'oe-vm'])).rejects.toThrow();
  } finally { write.mockRestore(); errors.mockRestore(); vi.unstubAllEnvs(); oe.close(); }
});
