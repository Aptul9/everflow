import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../src/core/config.ts';
import { openDb } from '../src/core/db.ts';
import { ChatToken } from '../src/web/chat-gate.ts';
import { bridgeTag, inject } from '../src/web/chat-bridge.ts';
import { hashPassword, loginKey, Sessions, SESSION_MS } from '../src/web/login.ts';
import { webFixture } from './web-fixture.ts';
import { actionHeaders, http, launch, rootToken } from './web-support.ts';
import { scratch } from './support.ts';

const PUBLIC = 'https://everflow.example.invalid';
const CHAT = 'https://chat.everflow.example.invalid';
const UI_PASSWORD = 'synthetic-ui-secret';
const DAY = 24 * 60 * 60 * 1000;

// OpenChamber's two auth calls the gate uses: POST /auth/session mints a client token, GET /auth/session checks one
function openchamber() {
  const state = { minted: 0, valid: new Set<string>(), mints: [] as unknown[], registered: [] as unknown[], pages: [] as string[], down: false, expiresAt: () => new Date(Date.now() + 7 * DAY).toISOString() };
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
      // the session lookup and project registration the chat dialog asks for, with the client token
      if (!state.valid.has((request.headers.authorization ?? '').replace(/^Bearer /, ''))) { response.writeHead(401).end('{}'); return; }
      // the chat view the bridge serves: OpenChamber's page, or a dropped connection when it is down
      if (request.method === 'GET' && (request.url ?? '').startsWith('/mini-chat.html')) {
        state.pages.push(request.url ?? '');
        if (state.down) { request.socket.destroy(); return; }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "frame-ancestors 'self'", 'x-upstream': 'openchamber', etag: '"v1"' })
          .end('<!doctype html><html><head><title>OpenChamber Mini Chat</title></head><body><div id="root"></div></body></html>');
        return;
      }
      const folders: Record<string, string> = { ses_vault: '/home/aptul/Vault', ses_untrusted: '/home/aptul/untrusted', ses_link: '/tmp/link' };
      const lookup = /^\/api\/session\/([^/]+)$/.exec(request.url ?? '');
      if (request.method === 'GET' && /^\/api\/session\/ses_vault\/message\?/.test(request.url ?? '')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [], cursor: { previous: null, next: null } }));
        return;
      }
      if (request.method === 'GET' && lookup) {
        const folder = folders[decodeURIComponent(lookup[1]!)];
        response.writeHead(folder ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(folder ? { data: { id: lookup[1], location: { directory: folder } } } : { error: 'not found' }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/projects/session-directory') {
        const body = JSON.parse(text) as { sessionId: string; directory: string };
        state.registered.push(body);
        if (body.directory.endsWith('untrusted')) { response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'opencode_trust_required' })); return; }
        const directory = body.directory === '/tmp/link' ? '/private/tmp/link' : body.directory;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ project: { path: directory }, directory }));
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

test('chat dialog: the session folder comes from OpenChamber and is registered as a project before the page frames the chat', async () => {
  const peer = openchamber();
  servers.push(peer.server);
  const token = new ChatToken(scratch('chat-token-').path + '.chat-token', `http://127.0.0.1:${await peer.ready}`, () => UI_PASSWORD);
  expect(await token.open('ses_vault')).toBe('/home/aptul/Vault');
  expect(peer.state.registered).toEqual([{ sessionId: 'ses_vault', directory: '/home/aptul/Vault' }]);
  // OpenChamber answers with the canonical spelling of a symlinked folder, which is the one its chat view matches
  expect(await token.open('ses_link')).toBe('/private/tmp/link');
  await expect(token.open('ses_gone')).rejects.toMatchObject({ status: 404, code: 'chat.not-found' });
  await expect(token.open('ses_untrusted')).rejects.toMatchObject({ status: 409, code: 'chat.untrusted', message: expect.stringContaining('/home/aptul/untrusted') });
  expect(peer.state.registered).toHaveLength(3);
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

    // the chat dialog: the guarded action answers with the session and the folder OpenChamber keeps it in, registered
    const headers = actionHeaders(server.port, rootToken((await http(server.port, '/')).text));
    const openChat = (id: number) => http(server.port, `/api/ticket/${id}/open-chat`, { method: 'POST', body: '{}', headers });
    expect(JSON.parse((await openChat(fixture.proposal)).text)).toEqual({ error: { code: 'chat.none', message: `Ticket #${fixture.proposal} has no chat yet` } });
    { using db = openDb(fixture.path); db.prepare('UPDATE ticket SET session_id=? WHERE id=?').run('ses_vault', fixture.active); db.prepare('UPDATE ticket SET session_id=? WHERE id=?').run('ses_gone', fixture.waiting); }
    const opened = await openChat(fixture.active);
    expect(opened.status).toBe(200);
    expect(JSON.parse(opened.text)).toEqual({ ticket: fixture.active, session_id: 'ses_vault', directory: '/home/aptul/Vault' });
    expect(peer.state.registered).toEqual([{ sessionId: 'ses_vault', directory: '/home/aptul/Vault' }]);
    const gone = await openChat(fixture.waiting);
    expect([gone.status, JSON.parse(gone.text).error.code]).toEqual([404, 'chat.not-found']);
    expect((await http(server.port, `/api/ticket/${fixture.active}/open-chat`, { method: 'POST', body: '{}', headers: { ...headers, 'x-everflow-token': 'f'.repeat(64) } })).status).toBe(403);

    // the files beside the chat: the same guarded action route, only files the chat's history names
    const listed = await http(server.port, `/api/ticket/${fixture.active}/chat-files`, { method: 'POST', body: '{}', headers });
    expect([listed.status, JSON.parse(listed.text)]).toEqual([200, { ticket: fixture.active, files: [] }]);
    const refused = await http(server.port, `/api/ticket/${fixture.active}/chat-file`, { method: 'POST', body: JSON.stringify({ path: '/etc/passwd' }), headers });
    expect([refused.status, JSON.parse(refused.text).error.code]).toEqual([404, 'file.not-listed']);
    expect((await http(server.port, `/api/ticket/${fixture.active}/chat-file`, { method: 'POST', body: JSON.stringify({ path: '/etc/passwd', extra: 1 }), headers })).status).toBe(400);
    expect((await http(server.port, `/api/ticket/${fixture.active}/chat-files`, { method: 'POST', body: '{}', headers: { ...headers, 'x-everflow-token': 'f'.repeat(64) } })).status).toBe(403);
    expect(JSON.parse((await http(server.port, `/api/ticket/${fixture.proposal}/chat-files`, { method: 'POST', body: '{}', headers })).text).error.code).toBe('chat.none');

    // the chat view through the bridge: Caddy's request for the chat host, after the gate, with the page session
    const bridge = (path: string, extra: Record<string, string> = {}) => http(server.port, `/api/chat-bridge${path}`, { headers: { 'x-forwarded-host': 'chat.everflow.example.invalid', cookie, ...extra } });
    const page = await bridge('/mini-chat.html?mode=session&sessionId=ses_vault&directory=%2Fhome%2Faptul%2FVault');
    expect(page.status).toBe(200);
    expect(page.text).toBe('<!doctype html><html><head><title>OpenChamber Mini Chat</title>'
      + `<script src="/everflow-bridge.js?parent=${encodeURIComponent(PUBLIC)}" defer></script></head><body><div id="root"></div></body></html>`);
    expect(page.text.match(/everflow-bridge\.js/g)).toHaveLength(1);
    expect([page.headers['content-type'], page.headers['x-upstream'], page.headers['cache-control'], page.headers.etag]).toEqual(['text/html; charset=utf-8', 'openchamber', 'no-store', undefined]);
    expect(Number(page.headers['content-length'] ?? Buffer.byteLength(page.text))).toBe(Buffer.byteLength(page.text));
    expect(peer.state.pages).toEqual(['/mini-chat.html?mode=session&sessionId=ses_vault&directory=%2Fhome%2Faptul%2FVault']);
    const script = await bridge('/everflow-bridge.js?parent=x');
    expect([script.status, script.headers['content-type']]).toEqual([200, 'text/javascript; charset=utf-8']);
    expect(script.text).toContain("type: 'everflow:open-file'");
    expect((await bridge('/index.html')).status).toBe(404);
    expect((await bridge('/mini-chat.html', { cookie: '' })).status).toBe(401);
    // not Caddy's request for the chat host, or under the public host: 404, and OpenChamber is not asked
    expect((await bridge('/mini-chat.html', { 'x-forwarded-host': 'everflow.example.invalid' })).status).toBe(404);
    expect((await http(server.port, '/api/chat-bridge/mini-chat.html', { headers: { cookie } })).status).toBe(404);
    expect((await http(server.port, '/api/chat-bridge/mini-chat.html', { headers: { host: 'everflow.example.invalid', 'x-forwarded-host': 'chat.everflow.example.invalid', cookie } })).status).toBe(404);
    expect((await http(server.port, '/api/chat-bridge/everflow-bridge.js', { headers: { host: 'everflow.example.invalid', 'x-forwarded-host': 'chat.everflow.example.invalid', cookie } })).status).toBe(404);
    expect(peer.state.pages).toHaveLength(1);
    // OpenChamber down: a page that says so, never an empty frame
    peer.state.down = true;
    const down = await bridge('/mini-chat.html?mode=session&sessionId=ses_vault');
    expect([down.status, down.headers['content-type']]).toEqual([502, 'text/html; charset=utf-8']);
    expect(down.text).toContain('role="alert">The chat could not be loaded');
    peer.state.down = false;
  } finally { await server.close(); }
}, 120_000);

test('served gate with EverID only: an EverID session opens the chat host, websocket handshakes included; password sessions do not', async () => {
  const peer = openchamber();
  servers.push(peer.server);
  const ocPort = await peer.ready;
  const fixture = webFixture();
  writeFileSync(fixture.config, readFileSync(fixture.config, 'utf8').replace('[opencode]\n', `[opencode]\nopenchamber_port = ${ocPort}\n`)
    + `[web]\npublic_origin = "${PUBLIC}"\nchat_origin = "${CHAT}"\n`);
  const account = { user: 'me@example.invalid', hash: hashPassword('synthetic secret') };
  // never contacted here: the gate checks the session cookie only
  const issuer = 'http://127.0.0.1:9/application/o/everflow/', clientId = 'everflow';
  const server = await launch('web-process.ts', [], { TEST_INSTANCE_CONFIG: fixture.config, EVERFLOW_LOGIN_USER: account.user, EVERFLOW_LOGIN_HASH: account.hash,
    OPENCHAMBER_UI_PASSWORD: UI_PASSWORD, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: 'synthetic-client-secret',
    EVERFLOW_PASSWORD_LOGIN: 'off' });
  try {
    const key = loginKey(fixture.path), now = Date.now();
    // the session the EverID callback issues, bound as server.ts binds it (issuer, client, account email, no listed subjects)
    const everid = new Sessions(key, account, { password: false, everid: [issuer, clientId, account.user].join('\0') });
    const cookie = `everflow_session=${everid.issue(now, 'o1')}`;
    const passwordCookie = `everflow_session=${new Sessions(key, account).issue(now)}`;
    const gate = (headers: Record<string, string>) => http(server.port, '/api/chat-gate', { headers: { 'x-forwarded-host': 'chat.everflow.example.invalid', 'x-forwarded-uri': '/?session=ses_1', ...headers } });

    const ok = await gate({ cookie });
    expect(ok.status).toBe(204);
    expect(ok.headers['x-everflow-chat-authorization']).toBe('Bearer oc_client_synthetic1');
    // a websocket handshake (events, terminal) as Caddy's forward_auth sends it: Connection and Upgrade stripped (Caddyfile
    // header_up), the handshake's other headers kept; the gate answers it like any request
    const ws = await gate({ cookie, 'x-forwarded-method': 'GET', 'x-forwarded-uri': '/api/event', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13' });
    expect(ws.status).toBe(204);
    expect(ws.headers['x-everflow-chat-authorization']).toBe('Bearer oc_client_synthetic1');
    const wsDenied = await gate({ 'x-forwarded-uri': '/api/event', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' });
    expect(wsDenied.status).toBe(401);
    expect(wsDenied.headers['x-everflow-chat-authorization']).toBeUndefined();
    // the fallback is off: a password session no longer opens the chat host, and the password sign-in is refused
    const old = await gate({ cookie: passwordCookie });
    expect(old.status).toBe(401);
    expect(old.headers['x-everflow-login']).toBe(`${PUBLIC}/login?next=${encodeURIComponent(`${CHAT}/?session=ses_1`)}`);
    const refused = await http(server.port, '/api/login', { method: 'POST', body: JSON.stringify({ email: account.user, password: 'synthetic secret' }),
      headers: { host: 'everflow.example.invalid', origin: PUBLIC, 'content-type': 'application/json' } });
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.text).error.code).toBe('everid.unavailable');
    // the bridge behind the gate takes the EverID session too
    const page = await http(server.port, '/api/chat-bridge/mini-chat.html?mode=session&sessionId=ses_vault', { headers: { 'x-forwarded-host': 'chat.everflow.example.invalid', cookie } });
    expect(page.status).toBe(200);
  } finally { await server.close(); }
}, 120_000);

test('the bridge tag goes in before </head> once, and on top of a page without a head', () => {
  const tag = `<script src="/everflow-bridge.js?parent=${encodeURIComponent(PUBLIC)}" defer></script>`;
  const once = inject('<html><HEAD><title>x</title></HEAD><body></body></html>', PUBLIC);
  expect(once).toBe(`<html><HEAD><title>x</title>${tag}</HEAD><body></body></html>`);
  expect(inject(once, PUBLIC)).toBe(once);
  expect(inject('<p>no head</p>', PUBLIC)).toBe(`${tag}<p>no head</p>`);
  expect(bridgeTag('https://a.invalid"><script>')).not.toContain('"><script>');
});

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
