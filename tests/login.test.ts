import { appendFileSync, statSync } from 'node:fs';
import { expect, test } from 'vitest';
import { cookieValue, hashPassword, Limiter, loginAccount, loginKey, openPath, safeNext, Sessions, SESSION_MS, verifyPassword } from '../src/web/login.ts';
import { webFixture } from './web-fixture.ts';
import { http, launch } from './web-support.ts';
import { scratch } from './support.ts';

const ORIGIN = 'https://everflow.example.invalid';
const HOST = 'everflow.example.invalid';

test('scrypt hash verifies only its own password and never stores it', () => {
  const hash = hashPassword('synthetic secret');
  expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  expect(hash).not.toContain('synthetic');
  expect(verifyPassword('synthetic secret', hash)).toBe(true);
  expect(verifyPassword('synthetic secreT', hash)).toBe(false);
  expect(verifyPassword('synthetic secret', 'plain')).toBe(false);
  expect(hashPassword('same')).not.toBe(hashPassword('same'));
});

test('account comes only from a user and a valid scrypt hash in the environment', () => {
  const hash = hashPassword('x');
  expect(loginAccount({ EVERFLOW_LOGIN_USER: ' me@example.invalid ', EVERFLOW_LOGIN_HASH: hash })).toEqual({ user: 'me@example.invalid', hash });
  expect(() => loginAccount({ EVERFLOW_LOGIN_USER: 'me@example.invalid' })).toThrow(/login.account-required/);
  expect(() => loginAccount({ EVERFLOW_LOGIN_USER: 'me@example.invalid', EVERFLOW_LOGIN_HASH: 'x' })).toThrow(/login.account-required/);
});

test('sessions are signed, expire and end when the account or password changes', () => {
  const { path } = scratch('login-key-');
  const key = loginKey(path);
  expect(loginKey(path).equals(key)).toBe(true);
  if (process.platform !== 'win32') expect(statSync(path + '.login-key').mode & 0o777).toBe(0o600);
  const account = { user: 'me@example.invalid', hash: hashPassword('x') };
  const sessions = new Sessions(key, account);
  const now = Date.UTC(2026, 10, 15);
  const value = sessions.issue(now);
  expect(sessions.valid(value, now + 1000)).toBe(true);
  expect(sessions.valid(value, now + SESSION_MS + 1)).toBe(false);
  expect(sessions.valid(value.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), now)).toBe(false);
  expect(sessions.valid(`v1.${now + SESSION_MS * 10}.${value.split('.')[2]}`, now)).toBe(false);
  expect(new Sessions(key, { ...account, hash: hashPassword('y') }).valid(value, now)).toBe(false);
  expect(new Sessions(Buffer.alloc(32, 7), account).valid(value, now)).toBe(false);
  expect(sessions.valid(undefined, now)).toBe(false);
});

test('lockout: five failures lock a client for the window, thirty lock everyone, success clears the client', () => {
  const limiter = new Limiter(), at = 1_000_000;
  for (let i = 0; i < 4; i++) limiter.fail('a', at);
  expect(limiter.retryAfter('a', at)).toBe(0);
  limiter.fail('a', at);
  expect(limiter.retryAfter('a', at)).toBe(15 * 60 * 1000);
  expect(limiter.retryAfter('b', at)).toBe(0);
  expect(limiter.retryAfter('a', at + 15 * 60 * 1000)).toBe(0);
  limiter.clear('a');
  for (let i = 0; i < 30; i++) limiter.fail(`c${i}`, at);
  expect(limiter.retryAfter('fresh', at)).toBeGreaterThan(0);
});

test('helpers: cookie parsing, open paths and safe return targets', () => {
  expect(cookieValue('a=1; everflow_session=v1.x; b=2')).toBe('v1.x');
  expect(cookieValue('a=1')).toBeUndefined();
  expect(openPath('GET', '/login')).toBe(true);
  expect(openPath('GET', '/_next/static/chunk.js')).toBe(true);
  expect(openPath('GET', '/')).toBe(false);
  expect(openPath('GET', '/api/state')).toBe(false);
  expect(openPath('POST', '/login')).toBe(false);
  for (const bad of ['//evil.example', '/\\evil', 'https://evil.example', '/login?next=/', '/api/state', '', null]) expect(safeNext(bad)).toBe('/');
  expect(safeNext('/?q=1')).toBe('/?q=1');
});

test('served page: public host needs the sign-in, loopback does not, and a session opens the board', async () => {
  const fixture = webFixture();
  appendFileSync(fixture.config, `[web]\npublic_origin = "${ORIGIN}"\n`);
  const server = await launch('web-process.ts', [], { TEST_INSTANCE_CONFIG: fixture.config, EVERFLOW_LOGIN_USER: 'me@example.invalid', EVERFLOW_LOGIN_HASH: hashPassword('synthetic secret') });
  try {
    const pub = (path: string, options: Parameters<typeof http>[2] = {}) => http(server.port, path, { ...options, headers: { host: HOST, ...options.headers } });
    const login = (body: unknown, origin = ORIGIN) => pub('/api/login', { method: 'POST', body: JSON.stringify(body), headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' } });

    expect((await http(server.port, '/api/state')).status).toBe(200);
    const root = await pub('/');
    expect(root.status).toBe(303);
    expect(root.headers.location).toBe('/login?next=%2F');
    const state = await pub('/api/state');
    expect(state.status).toBe(401);
    expect(state.headers['x-everflow-login']).toBe('required');
    const page = await pub('/login');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Sign in to Everflow');
    expect(page.text).not.toContain('everflow-token');

    expect((await login({ email: 'me@example.invalid', password: 'synthetic secret' }, 'https://evil.example.invalid')).status).toBe(403);
    expect((await login({ email: 'me@example.invalid', password: 'wrong' })).status).toBe(401);
    expect((await login({ email: 'other@example.invalid', password: 'synthetic secret' })).status).toBe(401);
    const ok = await login({ email: 'ME@example.invalid', password: 'synthetic secret' });
    expect(ok.status).toBe(204);
    const set = String(ok.headers['set-cookie']);
    expect(set).toMatch(/^everflow_session=v1\.\d{13}\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    const cookie = set.split(';')[0]!;
    expect((await pub('/api/state', { headers: { cookie } })).status).toBe(200);
    const board = await pub('/', { headers: { cookie } });
    expect(board.status).toBe(200);
    expect(board.text).toContain('Sign out');
    expect((await pub('/login?next=%2F', { headers: { cookie } })).headers.location).toBe('/');
    expect((await http(server.port, '/')).text).not.toContain('Sign out');

    for (let i = 0; i < 5; i++) await login({ email: 'me@example.invalid', password: 'wrong' });
    const locked = await login({ email: 'me@example.invalid', password: 'synthetic secret' });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

    const out = await pub('/api/logout', { method: 'POST', headers: { origin: ORIGIN, cookie } });
    expect(out.status).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
  } finally { await server.close(); }
}, 120_000);

test('a public origin without an account refuses to start', async () => {
  const fixture = webFixture();
  appendFileSync(fixture.config, `[web]\npublic_origin = "${ORIGIN}"\n`);
  await expect(launch('web-process.ts', [], { TEST_INSTANCE_CONFIG: fixture.config, EVERFLOW_LOGIN_USER: '', EVERFLOW_LOGIN_HASH: '' })).rejects.toThrow(/login.account-required/);
}, 120_000);
