import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../src/core/config.ts';
import { ChatToken } from '../src/web/chat-gate.ts';
import { hashPassword, loginKey, Sessions, SESSION_MS } from '../src/web/login.ts';
import { webFixture } from './web-fixture.ts';
import { http, launch } from './web-support.ts';
import { scratch } from './support.ts';

const PUBLIC = 'https://everflow.example.invalid';
const CHAT = 'https://chat.everflow.example.invalid';
const UI_PASSWORD = 'synthetic-ui-secret';
const DAY = 24 * 60 * 60 * 1000;

// OpenChamber's two auth calls the gate uses: POST /auth/session mints a client token, GET /auth/session checks one
function openchamber() {
  const state = { minted: 0, valid: new Set<string>(), mints: [] as unknown[], expiresAt: () => new Date(Date.now() + 7 * DAY).toISOString() };
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (part: Buffer) => { text += part.toString(); });
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/auth/session') {
        const body = JSON.parse(text) as { password?: string };
        state.mints.push(body);
        if (body.password !== UI_PASSWORD) { response.writeHead(401).end('{}'); return; }
        const token = `oc_client_synthetic${++state.minted}`;
        state.valid.add(token);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ authenticated: true, clientToken: token, client: { expiresAt: state.expiresAt() } }));
        return;
      }
      if (request.method === 'GET' && request.url === '/auth/session') {
        const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
        response.writeHead(state.valid.has(token) ? 200 : 401, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      response.writeHead(404).end();
    });
  });
  return { state, server, ready: new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))) };
}

const servers: { close: () => unknown }[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

test('client token: minted once with the UI password, stored owner-only, reused, minted again only on 401 or near expiry', async () => {
  const peer = openchamber();
  servers.push(peer.server);
  const url = `http://127.0.0.1:${await peer.ready}`;
  const file = scratch('chat-token-').path + '.chat-token';
  const token = new ChatToken(file, url, () => UI_PASSWORD);
  const first = await token.token();
  expect(first).toBe('oc_client_synthetic1');
  expect(peer.state.mints).toEqual([{ password: UI_PASSWORD, trustDevice: true, issueClientToken: true, clientLabel: 'Everflow web', clientKind: 'web',
    dedupeKey: 'everflow-web', deviceName: 'Everflow web' }]);
  expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe(first);
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await token.token()).toBe(first);
  // a restart reads the stored token and checks it instead of minting
  const restarted = new ChatToken(file, url, () => UI_PASSWORD);
  expect(await restarted.token()).toBe(first);
  expect(peer.state.minted).toBe(1);
  // revoked in OpenChamber: the next check gets 401 and mints a new one
  peer.state.valid.clear();
  expect(await restarted.token(Date.now() + 61_000)).toBe('oc_client_synthetic2');
  // a token within a day of its expiry is replaced before OpenChamber starts refusing it
  writeFileSync(file, JSON.stringify({ token: 'oc_client_synthetic2', expires_at: new Date(Date.now() + DAY / 2).toISOString() }));
  expect(await new ChatToken(file, url, () => UI_PASSWORD).token()).toBe('oc_client_synthetic3');
  const refused = new ChatToken(scratch('chat-token-').path + '.chat-token', url, () => 'wrong');
  await expect(refused.token()).rejects.toThrow(/HTTP 401/);
  await expect(refused.token()).rejects.toThrow(/HTTP 401/);
  // the second refusal came from the backoff, without another login attempt at OpenChamber
  expect(peer.state.mints).toHaveLength(4);
  await expect(refused.token(Date.now() + 61_000)).rejects.toThrow(/HTTP 401/);
  expect(peer.state.mints).toHaveLength(5);
});

test('config: chat_origin needs public_origin and openchamber_port', () => {
  const { root } = scratch('chat-origin-');
  const load = (text: string) => {
    const path = `${root}/c-${Math.random().toString(36).slice(2)}.toml`;
    writeFileSync(path, `[db]\npath = "fixture.db"\n${text}`);
    return loadConfig(path);
  };
  expect(load(`[opencode]\nopenchamber_port = 3000\n[web]\npublic_origin = "${PUBLIC}"\nchat_origin = "https://Chat.Everflow.Example.Invalid"\n`).web.chat_origin).toBe(CHAT);
  expect(() => load(`[opencode]\nopenchamber_port = 3000\n[web]\nchat_origin = "${CHAT}"\n`)).toThrow(/chat_origin/);
  expect(() => load(`[web]\npublic_origin = "${PUBLIC}"\nchat_origin = "${CHAT}"\n`)).toThrow(/openchamber_port/);
  expect(() => load(`[opencode]\nopenchamber_port = 3000\n[web]\npublic_origin = "${PUBLIC}"\nchat_origin = "${PUBLIC}"\n`)).toThrow(/chat_origin/);
  expect(() => load(`[opencode]\nopenchamber_port = 3000\n[web]\npublic_origin = "${PUBLIC}"\nchat_origin = "http://chat.example.invalid"\n`)).toThrow(/chat_origin/);
});

test('served gate: a page session gets the bearer on loopback, nothing under the public host, 401 with the sign-in address otherwise', async () => {
  const peer = openchamber();
  servers.push(peer.server);
  const ocPort = await peer.ready;
  const fixture = webFixture();
  writeFileSync(fixture.config, readFileSync(fixture.config, 'utf8').replace('[opencode]\n', `[opencode]\nopenchamber_port = ${ocPort}\n`)
    + `[web]\npublic_origin = "${PUBLIC}"\nchat_origin = "${CHAT}"\n`);
  const account = { user: 'me@example.invalid', hash: hashPassword('synthetic secret') };
  const server = await launch('web-process.ts', [], { TEST_INSTANCE_CONFIG: fixture.config, EVERFLOW_LOGIN_USER: account.user, EVERFLOW_LOGIN_HASH: account.hash,
    OPENCHAMBER_UI_PASSWORD: UI_PASSWORD });
  try {
    const sessions = new Sessions(loginKey(fixture.path), account);
    const cookie = `everflow_session=${sessions.issue()}`;
    const gate = (headers: Record<string, string>) => http(server.port, '/api/chat-gate', { headers: { 'x-forwarded-host': 'chat.everflow.example.invalid', 'x-forwarded-uri': '/?session=ses_1', ...headers } });

    const ok = await gate({ cookie });
    expect(ok.status).toBe(204);
    expect(ok.headers['x-everflow-chat-authorization']).toBe('Bearer oc_client_synthetic1');
    // a stale host-only cookie next to a valid domain one
    expect((await gate({ cookie: `everflow_session=v1.0000000000000.${'A'.repeat(43)}; ${cookie}` })).status).toBe(204);
    expect(peer.state.minted).toBe(1);

    for (const headers of [{}, { cookie: `everflow_session=${sessions.issue(Date.now() - SESSION_MS - 1000)}` }, { cookie: 'everflow_session=v1.9999999999999.' + 'A'.repeat(43) }]) {
      const denied = await gate(headers);
      expect(denied.status).toBe(401);
      expect(denied.headers['x-everflow-chat-authorization']).toBeUndefined();
      expect(denied.headers['x-everflow-login']).toBe(`${PUBLIC}/login?next=${encodeURIComponent(`${CHAT}/?session=ses_1`)}`);
    }

    // under the public host, from a browser: 404 with or without a session
    for (const headers of [{ cookie }, {}]) {
      const pub = await http(server.port, '/api/chat-gate', { headers: { host: 'everflow.example.invalid', 'x-forwarded-host': 'chat.everflow.example.invalid', ...headers } });
      expect(pub.status).toBe(404);
      expect(pub.headers['x-everflow-chat-authorization']).toBeUndefined();
    }
    // loopback, but not Caddy's request for the chat host
    expect((await http(server.port, '/api/chat-gate', { headers: { cookie } })).status).toBe(404);
    expect((await gate({ cookie, 'x-forwarded-host': 'everflow.example.invalid' })).status).toBe(404);
    // the chat host itself never reaches the daemon
    expect((await http(server.port, '/', { headers: { host: 'chat.everflow.example.invalid', cookie } })).status).toBe(403);

    // signing in on the page sets the cookie for the page host and the chat host under it; next goes back to the chat host
    const login = await http(server.port, '/api/login', { method: 'POST', body: JSON.stringify({ email: account.user, password: 'synthetic secret' }),
      headers: { host: 'everflow.example.invalid', origin: PUBLIC, 'content-type': 'application/json' } });
    expect(login.status).toBe(204);
    expect(login.headers['set-cookie']).toEqual([expect.stringMatching(/^everflow_session=v1\.\d{13}\.[A-Za-z0-9_-]{43}; Path=\/; Domain=everflow\.example\.invalid; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/)]);
    const back = await http(server.port, `/login?next=${encodeURIComponent(`${CHAT}/?session=ses_1`)}`, { headers: { host: 'everflow.example.invalid', cookie } });
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe(`${CHAT}/?session=ses_1`);
    expect(String(back.headers['set-cookie'])).toContain('Domain=everflow.example.invalid');
    const evil = await http(server.port, `/login?next=${encodeURIComponent('https://evil.example.invalid/')}`, { headers: { host: 'everflow.example.invalid', cookie } });
    expect(evil.headers.location).toBe('/');
    const out = await http(server.port, '/api/logout', { method: 'POST', headers: { host: 'everflow.example.invalid', origin: PUBLIC, cookie } });
    expect(out.headers['set-cookie']).toEqual(['everflow_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      'everflow_session=; Path=/; Domain=everflow.example.invalid; HttpOnly; Secure; SameSite=Lax; Max-Age=0']);
    const board = await http(server.port, '/api/state', { headers: { host: 'everflow.example.invalid', cookie } });
    expect(JSON.parse(board.text).chat_origin).toBe(CHAT);
  } finally { await server.close(); }
}, 120_000);

test('without chat_origin the gate is absent and the cookie stays host-only', async () => {
  const fixture = webFixture();
  writeFileSync(fixture.config, readFileSync(fixture.config, 'utf8') + `[web]\npublic_origin = "${PUBLIC}"\n`);
  const account = { user: 'me@example.invalid', hash: hashPassword('synthetic secret') };
  const server = await launch('web-process.ts', [], { TEST_INSTANCE_CONFIG: fixture.config, EVERFLOW_LOGIN_USER: account.user, EVERFLOW_LOGIN_HASH: account.hash });
  try {
    const cookie = `everflow_session=${new Sessions(loginKey(fixture.path), account).issue()}`;
    expect((await http(server.port, '/api/chat-gate', { headers: { cookie, 'x-forwarded-host': 'chat.everflow.example.invalid' } })).status).toBe(404);
    const login = await http(server.port, '/api/login', { method: 'POST', body: JSON.stringify({ email: account.user, password: 'synthetic secret' }),
      headers: { host: 'everflow.example.invalid', origin: PUBLIC, 'content-type': 'application/json' } });
    expect(String(login.headers['set-cookie'])).not.toContain('Domain=');
    expect((await http(server.port, `/login?next=${encodeURIComponent(`${CHAT}/`)}`, { headers: { host: 'everflow.example.invalid', cookie } })).headers.location).toBe('/');
    expect(JSON.parse((await http(server.port, '/api/state')).text).chat_origin).toBeUndefined();
  } finally { await server.close(); }
}, 120_000);
