import { createCipheriv, createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createDpapi } from '../src/windows/dpapi.ts';
import { NativeError } from '../src/windows/kernel.ts';
import { decryptCookie, harvestCookieAccounts, protectedTeamsCache, stripToken, TeamsAuth } from '../src/watchers/teams-auth.ts';
import type { TeamsAccount, TeamsAuthState } from '../src/watchers/teams-auth.ts';
import { createTeamsState, htmlToText, scanTeams, TeamsClient, teamsPages, teamsUrl } from '../src/watchers/teams.ts';
import type { TeamsPort } from '../src/watchers/teams.ts';
import { safeSourceDiagnostic } from '../src/watchers/source.ts';
import type { SourceRecord } from '../src/watchers/source.ts';
import { scratch } from './support.ts';

const now = Date.parse('2026-11-04T11:00:00.000Z');
const since = '2026-11-04T10:00:00.000Z';
const key = Buffer.alloc(32, 7);
const host = 'fixture.asyncgw.teams.microsoft.com';
function token(upn: string, exp = now / 1000 + 600, oid = 'me') {
  return `synthetic.${Buffer.from(JSON.stringify({ upn, exp, oid })).toString('base64url')}.fixture`;
}
function account(upn = 'a@example.invalid', exp = now / 1000 + 600): TeamsAccount {
  return { upn, ic3: token(upn, exp), exp, region: 'emea', oid: 'me' };
}
function encrypted(value: string, format = 'v10', hostname = host, prefix = true) {
  const nonce = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  return Buffer.concat([Buffer.from(format), nonce, cipher.update(Buffer.concat([...(prefix ? [createHash('sha256').update(hostname).digest()] : []), Buffer.from(value)])), cipher.final(), cipher.getAuthTag()]);
}

test.each(['v10', 'v20'])('%s AES-GCM cookies validate Chromium host prefix and return token bytes', (format) => {
  const value = token('a@example.invalid');
  const result = decryptCookie(encrypted(value, format), key, host, true);
  expect(result.toString()).toBe(value);
  result.fill(0);
});

test('legacy unprefixed cookies remain compatible only before schema24', () => {
  expect(decryptCookie(encrypted('fixture', 'v10', host, false), key, host, false).toString()).toBe('fixture');
  expect(() => decryptCookie(encrypted('fixture', 'v10', host, false), key, host, true)).toThrow(/cookie.host-prefix/);
});

test('cookie authentication, wrong host and v21 failures preserve fixed nonsecret check IDs', () => {
  const bytes = encrypted('SYNTHETIC_TOKEN_DO_NOT_PRINT');
  bytes[bytes.length - 1]! ^= 1;
  expect(() => decryptCookie(bytes, key, host, true)).toThrow(/^cookie.aes-authentication$/);
  expect(() => decryptCookie(encrypted('fixture'), key, 'wrong.host', true)).toThrow(/^cookie.host-prefix$/);
  expect(() => decryptCookie(Buffer.from('v21fixture'), key, host, true)).toThrow(/^cookie.unsupported-v21$/);
});

test('bearer decoding preserves plus and tolerates malformed percent runs', () => {
  expect(stripToken('BeArEr%3Dfixture%2Bvalue')).toBe('fixture+value');
  expect(stripToken('a+b')).toBe('a+b');
  expect(stripToken('x%ZZ%C3')).toBe('x%ZZ\uFFFD');
});

test('cookie accounts retain expired inventory, latest expiry, alternate UPN claim and associated region', () => {
  const a = account();
  const alternate = `synthetic.${Buffer.from(JSON.stringify({ unique_name: 'b@example.invalid', exp: now / 1000 - 60 })).toString('base64url')}.fixture`;
  const regionToken = `synthetic.${Buffer.from(JSON.stringify({ oid: 'me', exp: a.exp })).toString('base64url')}.fixture`;
  const rows = [
    { host_key: host, name: 'authtoken_asm', path: '/', encrypted_value: encrypted(token(a.upn, a.exp - 30)) },
    { host_key: host, name: 'authtoken_asm', path: '/', encrypted_value: encrypted(a.ic3) },
    { host_key: host, name: 'authtoken_asm', path: '/', encrypted_value: encrypted(alternate) },
    { host_key: 'teams.microsoft.com', name: 'authtoken', path: '/mt/part/us-01/', encrypted_value: encrypted(regionToken, 'v20', 'teams.microsoft.com') },
  ];
  expect(harvestCookieAccounts(rows, key, true)).toMatchObject([
    { upn: 'a@example.invalid', exp: a.exp, region: 'us', oid: 'me' },
    { upn: 'b@example.invalid', exp: now / 1000 - 60, region: 'emea' },
  ]);
});

test('everflow cache uses DPAPI atomic writes, bootstrap stays unchanged and TeamsMCP target is refused', () => {
  const { root } = scratch('phase7-auth-cache-');
  const dpapi = createDpapi();
  const bootstrap = join(root, 'bootstrap.bin');
  const state: TeamsAuthState = { version: 1, accounts: [account()] };
  fs.writeFileSync(bootstrap, dpapi.protect(Buffer.from(JSON.stringify(state))));
  const before = fs.readFileSync(bootstrap);
  const path = join(root, 'everflow', 'tokens.bin');
  const cache = protectedTeamsCache({ path, bootstrap }, dpapi);
  expect(cache.load()).toMatchObject(state);
  cache.save({ ...state, attempted: now / 1000 });
  expect(fs.readFileSync(path).includes(Buffer.from(account().ic3))).toBe(false);
  expect(cache.load()?.attempted).toBe(now / 1000);
  expect(fs.readFileSync(bootstrap)).toEqual(before);
  expect(() => protectedTeamsCache({ path: bootstrap, bootstrap }, dpapi)).toThrow(/auth.cache-separation/);
  expect(() => protectedTeamsCache({ path: join(root, 'TeamsMCP', 'remote', 'tokens.bin') }, dpapi)).toThrow(/auth.cache-separation/);
});

test('sensitive cache JSON parse errors never disclose plaintext', () => {
  const { root } = scratch('phase7-auth-invalid-');
  const path = join(root, 'tokens.bin');
  const dpapi = createDpapi();
  fs.writeFileSync(path, dpapi.protect(Buffer.from('SYNTHETIC_TOKEN_INVALID_JSON')));
  expect(() => protectedTeamsCache({ path }, dpapi).load()).toThrow(/^auth.cache-json$/);
});

test('a controlled auth/cache check ID survives the scan diagnostic boundary', async () => {
  const port = teamsPort();
  port.accounts = async () => { throw new NativeError('auth.cache-json'); };
  const error = await scanTeams(port, createTeamsState(since), () => {}, () => now).catch((failure: unknown) => failure);
  expect(safeSourceDiagnostic(error, 'teams')).toMatchObject({ source: 'teams', code: 'teams.scan-incomplete', reason: 'auth.cache-json' });
});

test('arbitrary source exceptions never become scan diagnostic text', async () => {
  const port = teamsPort();
  port.request = async () => { throw new Error('SYNTHETIC_TOKEN_DO_NOT_PRINT'); };
  const error = await scanTeams(port, createTeamsState(since), () => {}, () => now).catch((failure: unknown) => failure);
  const diagnostic = safeSourceDiagnostic(error, 'teams');
  expect(diagnostic).toMatchObject({ code: 'teams.scan-incomplete', reason: 'source.unexpected' });
  expect(JSON.stringify(diagnostic)).not.toContain('SYNTHETIC_TOKEN_DO_NOT_PRINT');
});

function authFixture(initial: TeamsAuthState | null, fresh: TeamsAccount[] = [account()]) {
  let saved = initial;
  const dependencies = {
    load: () => saved,
    save: vi.fn((state: TeamsAuthState) => { saved = structuredClone(state); }),
    harvest: vi.fn(async () => fresh), now: () => now,
  };
  return { auth: new TeamsAuth(dependencies), dependencies };
}

test('valid cached tokens are reused without live refresh; expired cached accounts stay in known inventory', async () => {
  const { auth, dependencies } = authFixture({ version: 1, accounts: [account()] });
  expect(await auth.accounts()).toEqual([account()]);
  expect(dependencies.harvest).not.toHaveBeenCalled();
  const expired = authFixture({ version: 1, accounts: [account(), account('b@example.invalid', now / 1000 - 1)] });
  await expired.auth.accounts();
  expect(expired.auth.knownAccounts()).toEqual(['a@example.invalid', 'b@example.invalid']);
});

test('failed refresh is throttled and never reuses the rejected token', async () => {
  const { auth, dependencies } = authFixture({ version: 1, accounts: [account()], attempted: now / 1000 - 10 });
  await expect(auth.refreshRejected(account())).rejects.toThrow(/auth.refresh-throttled/);
  expect(dependencies.harvest).not.toHaveBeenCalled();
});

test('concurrent rejected-token refreshes share one harvest and persist attempted timestamp', async () => {
  const old = account();
  const fresh = { ...old, ic3: token(old.upn, old.exp + 100), exp: old.exp + 100 };
  const { auth, dependencies } = authFixture({ version: 1, accounts: [old] }, [fresh]);
  const result = await Promise.all([auth.refreshRejected(old), auth.refreshRejected(old)]);
  expect(result).toEqual([fresh, fresh]);
  expect(dependencies.harvest).toHaveBeenCalledOnce();
  expect(dependencies.save.mock.calls[0]![0].attempted).toBe(now / 1000);
});

test('Teams HTTP retries exactly one 401 after fresh-token rejection refresh; never retries 403 or a second 401', async () => {
  for (const statuses of [[401, 200], [401, 401], [403]]) {
    const a = account();
    const fresh = { ...a, ic3: 'synthetic fresh token' };
    const refreshRejected = vi.fn(async () => fresh);
    const requests: RequestInit[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(init!);
      return new Response(JSON.stringify({ conversations: [] }), { status: statuses[requests.length - 1]! });
    });
    const client = new TeamsClient({ refreshRejected }, fetcher);
    if (statuses.at(-1) === 200) await expect(client.request(a, 'https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations')).resolves.toEqual({ conversations: [] });
    else await expect(client.request(a, 'https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations')).rejects.toThrow(/teams.http/);
    expect(fetcher).toHaveBeenCalledTimes(statuses.length);
    expect(refreshRejected).toHaveBeenCalledTimes(statuses[0] === 401 ? 1 : 0);
    expect(requests[0]!.headers).toMatchObject({ Authorization: `Bearer ${a.ic3}` });
    if (requests[1]) expect(requests[1].headers).toMatchObject({ Authorization: `Bearer ${fresh.ic3}` });
    expect(requests.every((request) => request.redirect === 'manual' && request.method === 'GET')).toBe(true);
  }
});

test.each(['https://attacker.invalid/steal', '//attacker.invalid/steal', 'http://teams.microsoft.com/api/chatsvc/emea/v1', 'https://teams.microsoft.com.attacker.invalid/', 'https://user:password@teams.microsoft.com/'])('backward URL %s is refused before bearer forwarding', async (url) => {
  const fetcher = vi.fn();
  const client = new TeamsClient({ refreshRejected: async () => account() }, fetcher);
  await expect(client.request(account(), url)).rejects.toThrow(/teams.origin/);
  expect(fetcher).not.toHaveBeenCalled();
});

test('pagination handles relative Teams links but fails explicitly at page bound', async () => {
  const request = vi.fn(async () => ({ messages: [{ originalarrivaltime: since }], _metadata: { backwardLink: '/api/chatsvc/emea/v1/users/ME/conversations/c/messages?page=2' } }));
  await expect(teamsPages({ request }, account(), teamsUrl('/api/chatsvc/emea/v1/users/ME/conversations/c/messages', 'emea'), 'messages', Date.parse(since) - 1, undefined, 2)).rejects.toThrow(/teams.pagination-limit/);
  expect(request).toHaveBeenCalledTimes(2);
});

function rawMessage() {
  return { id: '1', messagetype: 'RichText/Html', originalarrivaltime: '2026-11-04T10:30:00.1234567Z', from: '/contacts/8:orgid:bob', imdisplayname: 'Bob', content: '<p>Original &amp; text</p>', properties: {} as Record<string, unknown> };
}
function teamsPort(accounts = [account()]): TeamsPort {
  return { knownAccounts: () => accounts.map((a) => a.upn), accounts: async () => accounts,
    request: async (_account, url) => url.includes('/messages?') ? { messages: [rawMessage()] } : { conversations: [{ id: 'shared_chat' }] } };
}

test('successful once scan emits full account inventory and complete checkpoint after startTime bounded reads', async () => {
  const port = teamsPort();
  const request = vi.fn(port.request);
  port.request = request;
  const state = createTeamsState(since);
  const rows: SourceRecord[] = [];
  await scanTeams(port, state, (row) => { rows.push(row); }, () => now);
  expect(rows[0]).toEqual({ source: 'teams', accounts: ['a@example.invalid'] });
  expect(rows.at(-1)).toEqual({ source: 'teams', checkpoint: new Date(now).toISOString(), accounts: ['a@example.invalid'] });
  expect(request.mock.calls.every((call) => call[1].includes('pageSize=200') && call[1].includes(`startTime=${Date.parse(since) - 120_000}`))).toBe(true);
  expect(rows.find((row) => 'message_id' in row)).toMatchObject({ account: 'a@example.invalid', sender: 'bob', sender_is_me: false,
    sent_at: '2026-11-04T10:30:00.123Z', conversation_title: 'Bob', text: 'Original & text' });
});

test('failed account cannot advance global checkpoint, successful local cursor advances without losing failed coverage', async () => {
  const port = teamsPort([account(), account('b@example.invalid')]);
  const read = port.request;
  port.request = (a, url, signal) => a.upn.startsWith('b@') ? Promise.reject(new Error('synthetic offline')) : read(a, url, signal);
  const state = createTeamsState(since);
  const rows: SourceRecord[] = [];
  await expect(scanTeams(port, state, (row) => { rows.push(row); }, () => now)).rejects.toThrow(/teams.scan-incomplete/);
  expect(rows.some((row) => 'checkpoint' in row)).toBe(false);
  expect(state.since).toBe(since);
  expect(state.cursors.get('a@example.invalid')).toBe(new Date(now).toISOString());
  expect(state.cursors.has('b@example.invalid')).toBe(false);
});

test.each(['cached-expired', 'persisted'])('missing %s account holds first-round Teams checkpoint', async (kind) => {
  const port = teamsPort();
  if (kind === 'cached-expired') port.knownAccounts = () => ['a@example.invalid', 'b@example.invalid'];
  const state = createTeamsState(since, kind === 'persisted' ? ['b@example.invalid'] : []);
  const rows: SourceRecord[] = [];
  await expect(scanTeams(port, state, (row) => { rows.push(row); }, () => now)).rejects.toThrow(/teams.scan-incomplete/);
  expect(rows[0]).toEqual({ source: 'teams', accounts: ['a@example.invalid', 'b@example.invalid'] });
  expect(rows.some((row) => 'checkpoint' in row)).toBe(false);
});

test('shared account messages, edits and deletion tombstones are all emitted in the same process', async () => {
  const raw = rawMessage();
  const port = teamsPort([account(), account('b@example.invalid')]);
  port.request = async (_a, url) => url.includes('/messages?') ? { messages: [raw] } : { conversations: [{ id: 'shared_chat', threadProperties: { topic: 'Group topic' } }] };
  const state = createTeamsState(since);
  const rows: SourceRecord[] = [];
  const emit = (row: SourceRecord) => { rows.push(row); };
  await scanTeams(port, state, emit, () => now);
  await scanTeams(port, state, emit, () => now);
  raw.content = 'Edited'; raw.properties.edittime = new Date(now).toISOString();
  await scanTeams(port, state, emit, () => now);
  raw.properties.deletetime = new Date(now).toISOString();
  await scanTeams(port, state, emit, () => now);
  const messages = rows.filter((row) => 'message_id' in row);
  expect(messages).toHaveLength(6);
  expect(messages.map((row) => row.account)).toEqual(['a@example.invalid', 'b@example.invalid', 'a@example.invalid', 'b@example.invalid', 'a@example.invalid', 'b@example.invalid']);
  expect(messages.at(-1)).toMatchObject({ text: '', attachments: [], ref: { deleted: true }, conversation_title: 'Group topic' });
});

test('hidden conversations and activity/control messages are excluded, own flag remains a real boolean', async () => {
  const own = { ...rawMessage(), from: '/contacts/8:orgid:me' };
  const port = teamsPort();
  port.request = async (_a, url) => url.includes('/messages?') ? { messages: [own, { ...own, id: 'control', messagetype: 'Control/Typing' }, { ...own, id: 'activity', messagetype: 'ThreadActivity/AddMember' }] }
    : { conversations: [{ id: '48:notifications' }, { id: '19:meeting', threadProperties: { threadTopic: 'Meeting topic' } }] };
  const rows: SourceRecord[] = [];
  await scanTeams(port, createTeamsState(since), (row) => { rows.push(row); }, () => now);
  expect(rows.filter((row) => 'message_id' in row)).toMatchObject([{ sender_is_me: true, conversation_title: 'Meeting topic' }]);
});

test('HTML normalization preserves code, mentions, reply context, links and non-ASCII entities', () => {
  expect(htmlToText('<p>Hello <span itemtype="http://schema.skype.com/Mention">Bob</span> &euro; &#169;</p><pre>a\n  b<br>c</pre><a href="https://example.invalid/x">link</a>')).toBe('Hello @Bob € ©\n\na\n  b\nc\nlink (https://example.invalid/x)');
});

test('protected cache refuses a junction alias into the read-only bootstrap directory before writing', () => {
  const { root } = scratch('phase7-cache-alias-');
  const vendor = join(root, 'TeamsMCP', 'remote');
  fs.mkdirSync(vendor, { recursive: true });
  const dpapi = createDpapi(), bootstrap = join(vendor, 'tokens.bin');
  fs.writeFileSync(bootstrap, dpapi.protect(Buffer.from(JSON.stringify({ version: 1, accounts: [account()] }))));
  const before = fs.readFileSync(bootstrap), alias = join(root, 'everflow-cache');
  fs.symlinkSync(vendor, alias, 'junction');
  const cache = protectedTeamsCache({ path: join(alias, 'tokens.bin'), bootstrap }, dpapi);
  expect(() => cache.save({ version: 1, accounts: [account('new@example.invalid')] })).toThrow(/auth.cache-path/);
  expect(fs.readFileSync(bootstrap)).toEqual(before);
});

test('cached expiry cannot outlive the actual JWT expiry', () => {
  const { root } = scratch('phase7-cache-expiry-');
  const path = join(root, 'tokens.bin'), dpapi = createDpapi();
  const stale = { ...account(), ic3: token('a@example.invalid', now / 1000 - 1) };
  fs.writeFileSync(path, dpapi.protect(Buffer.from(JSON.stringify({ version: 1, accounts: [stale] }))));
  expect(protectedTeamsCache({ path }, dpapi).load()!.accounts[0]!.exp).toBe(now / 1000 - 1);
});

test('later requests reuse the replacement token instead of repeatedly forwarding the rejected one', async () => {
  const a = account(), fresh = { ...a, ic3: token(a.upn, a.exp + 60), exp: a.exp + 60 };
  const refreshRejected = vi.fn(async () => fresh);
  const headers: Record<string, string>[] = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    headers.push(init!.headers as Record<string, string>);
    return new Response('{"conversations":[]}', { status: headers.length === 1 ? 401 : 200 });
  });
  const client = new TeamsClient({ refreshRejected }, fetcher);
  const url = 'https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations';
  await client.request(a, url); await client.request(a, url);
  expect(headers.map((header) => header.Authorization)).toEqual([`Bearer ${a.ic3}`, `Bearer ${fresh.ic3}`, `Bearer ${fresh.ic3}`]);
  expect(refreshRejected).toHaveBeenCalledOnce();
});

test.each([new Date(now).toISOString(), now, String(now)])('a partial deletion tombstone retains known timestamp and sender with deletion metadata %j', async (deletion) => {
  let raw: Record<string, unknown> = rawMessage();
  const port = teamsPort();
  port.request = async (_a, url) => url.includes('/messages?') ? { messages: [raw] } : { conversations: [{ id: 'chat' }] };
  const rows: SourceRecord[] = [], state = createTeamsState(since);
  await scanTeams(port, state, (row) => { rows.push(row); }, () => now);
  raw = { id: '1', properties: { deletetime: deletion } };
  await scanTeams(port, state, (row) => { rows.push(row); }, () => now);
  expect(rows.filter((row) => 'message_id' in row).at(-1)).toMatchObject({ sender: 'bob', sent_at: '2026-11-04T10:30:00.123Z', text: '', ref: { deleted: true } });
});

test.each([now - 60000, String(now - 60000)])('fresh-state epoch-ms tombstone %j emits deletion and complete account coverage', async (deletion) => {
  const port = teamsPort();
  const raw = { id: String(now), properties: { deletetime: deletion } };
  port.request = async (_account, url) => url.includes('/messages?') ? { messages: [raw] } : { conversations: [{ id: 'chat' }] };
  const state = createTeamsState(since), rows: SourceRecord[] = [];
  expect(state.metadata.size).toBe(0);
  await expect(scanTeams(port, state, (row) => { rows.push(row); }, () => now)).resolves.toBeUndefined();
  expect(rows.filter((row) => 'message_id' in row)).toMatchObject([{ source: 'teams', account: 'a@example.invalid', conversation_id: 'chat',
    message_id: `chat;messageid=${now}`, sent_at: '2026-11-04T10:59:00.000Z', sender_is_me: false, text: '', attachments: [], ref: { id: String(now), deleted: true } }]);
  expect(rows.at(-1)).toEqual({ source: 'teams', checkpoint: new Date(now).toISOString(), accounts: ['a@example.invalid'] });
  expect(state.since).toBe(new Date(now).toISOString());
  expect(state.cursors.get('a@example.invalid')).toBe(new Date(now).toISOString());
});

test.each([
  { check: 'nan-number', value: NaN }, { check: 'positive-infinity', value: Infinity }, { check: 'negative-infinity', value: -Infinity },
  { check: 'fractional-number', value: 1793790000000.5 }, { check: 'unsafe-integer', value: Number.MAX_SAFE_INTEGER + 1 }, { check: 'date-range', value: 8640000000000001 },
  { check: 'nan-string', value: 'NaN' }, { check: 'infinity-string', value: 'Infinity' }, { check: 'junk-suffix', value: '1793790000000x' },
  { check: 'fractional-string', value: '1793790000000.5' }, { check: 'object', value: {} }, { check: 'boolean', value: true },
])('invalid deletion timestamp $check cannot emit a tombstone or advance coverage', async ({ value: deletion }) => {
  const port = teamsPort();
  port.request = async (_account, url) => url.includes('/messages?') ? { messages: [{ id: String(now), properties: { deletetime: deletion } }] } : { conversations: [{ id: 'chat' }] };
  const state = createTeamsState(since), rows: SourceRecord[] = [];
  const error = await scanTeams(port, state, (row) => { rows.push(row); }, () => now).catch((failure: unknown) => failure);
  expect(safeSourceDiagnostic(error, 'teams')).toMatchObject({ code: 'teams.scan-incomplete', reason: 'teams.message-time' });
  expect(rows.some((row) => 'message_id' in row || 'checkpoint' in row)).toBe(false);
  expect(state.since).toBe(since); expect(state.cursors.size).toBe(0);
});

test('recovered failed account resumes its old floor while successful quiet account retains its local cursor', async () => {
  let failing = true;
  const port = teamsPort([account(), account('b@example.invalid')]);
  const urls: { account: string; url: string }[] = [];
  port.request = async (a, url) => {
    urls.push({ account: a.upn, url });
    if (a.upn.startsWith('b@') && failing) throw new Error('fixture offline');
    return { conversations: [] };
  };
  const state = createTeamsState(since), rows: SourceRecord[] = [];
  await expect(scanTeams(port, state, (row) => { rows.push(row); }, () => now)).rejects.toThrow(/teams.scan-incomplete/);
  failing = false; urls.length = 0;
  await scanTeams(port, state, (row) => { rows.push(row); }, () => now + 60000);
  expect(urls[0]!.url).toContain(`startTime=${now - 120000}`);
  expect(urls[1]!.url).toContain(`startTime=${Date.parse(since) - 120000}`);
  expect(rows.at(-1)).toMatchObject({ checkpoint: new Date(now + 60000).toISOString(), accounts: ['a@example.invalid', 'b@example.invalid'] });
});
