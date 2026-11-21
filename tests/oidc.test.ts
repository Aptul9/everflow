import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { hashPassword, passwordLogin, Sessions, openPath } from '../src/web/login.ts';
import { idClaims, Oidc, oidcSettings, openFlow, sealFlow } from '../src/web/oidc.ts';
import type { OidcSettings } from '../src/web/oidc.ts';
import { webFixture } from './web-fixture.ts';
import { http, launch } from './web-support.ts';

const ORIGIN = 'https://everflow.example.invalid';
const HOST = 'everflow.example.invalid';
const KEY = Buffer.alloc(32, 9);
const CLIENT = 'everflow-client', SECRET = 'synthetic-client-' + 'value';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.c2ln`;

// An OpenID Connect provider on loopback, shaped like Authentik's per-application issuer: discovery, an authorize step the
// test drives by hand, a token endpoint that checks client, redirect and PKCE, and userinfo carrying email and groups
function issuer() {
  const state = { email: 'me@example.invalid', groups: ['app-flow', 'everid-admins'], codes: new Map<string, { challenge: string; nonce: string; redirect: string }>(),
    tokenRequests: 0, down: false, nonce: '' as string | undefined, sub: 'user-1', infoSub: undefined as string | undefined, base: '' };
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (part: Buffer) => { text += part.toString(); });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const send = (status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (state.down) { send(503, {}); return; }
      if (url.pathname === '/application/o/everflow/.well-known/openid-configuration') {
        const root = state.base.replace(/everflow\/$/, '');
        send(200, { issuer: state.base, authorization_endpoint: `${root}authorize/`, token_endpoint: `${root}token/`, userinfo_endpoint: `${root}userinfo/`,
          end_session_endpoint: `${state.base}end-session/` });
        return;
      }
      if (url.pathname === '/application/o/token/' && request.method === 'POST') {
        state.tokenRequests++;
        const form = new URLSearchParams(text);
        const [id, secret] = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':').map(decodeURIComponent);
        const code = state.codes.get(form.get('code') ?? '');
        state.codes.delete(form.get('code') ?? '');
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (id !== CLIENT || secret !== SECRET || !code || code.redirect !== form.get('redirect_uri') || code.challenge !== challenge || form.get('grant_type') !== 'authorization_code') {
          send(400, { error: 'invalid_grant' }); return;
        }
        const nonce = state.nonce === undefined ? code.nonce : state.nonce || code.nonce;
        send(200, { access_token: 'at-' + form.get('code'), id_token: jwt({ iss: state.base, aud: CLIENT, sub: state.sub, nonce, exp: Math.floor(Date.now() / 1000) + 300 }) });
        return;
      }
      if (url.pathname === '/application/o/userinfo/') {
        if (!(request.headers.authorization ?? '').startsWith('Bearer at-')) { send(401, {}); return; }
        send(200, { sub: state.infoSub ?? state.sub, email: state.email, groups: state.groups });
        return;
      }
      response.writeHead(404).end();
    });
  });
  return {
    state, server,
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/application/o/everflow/`;
      return state.base;
    },
    // what Authentik does when the user signs in: a code bound to the request's challenge, nonce and redirect
    authorize(location: string) {
      const url = new URL(location);
      expect(url.pathname).toBe('/application/o/authorize/');
      expect(url.searchParams.get('client_id')).toBe(CLIENT);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('openid email profile');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      const code = 'code-' + Math.random().toString(36).slice(2);
      state.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, nonce: url.searchParams.get('nonce')!, redirect: url.searchParams.get('redirect_uri')! });
      return new URLSearchParams({ code, state: url.searchParams.get('state')! });
    },
  };
}

const servers: { close: () => void }[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

test('EverID settings come from the environment, all three or none, over https', () => {
  const env = { OIDC_ISSUER: 'https://id.example.invalid/application/o/everflow/', OIDC_CLIENT_ID: CLIENT, OIDC_CLIENT_SECRET: SECRET };
  expect(oidcSettings(ORIGIN, ' ME@example.invalid ', env, ['sub-a'])).toEqual({ issuer: env.OIDC_ISSUER, clientId: CLIENT, clientSecret: SECRET,
    redirectUri: `${ORIGIN}/oidc/callback`, postLogoutUri: `${ORIGIN}/`, email: 'me@example.invalid', group: 'app-flow', adminGroup: 'everid-admins', subjects: ['sub-a'] });
  expect(oidcSettings(ORIGIN, 'a', {})).toBeUndefined();
  expect(() => oidcSettings(ORIGIN, 'a', { OIDC_ISSUER: env.OIDC_ISSUER })).toThrow(/oidc.client-required/);
  expect(() => oidcSettings(ORIGIN, 'a', { ...env, OIDC_ISSUER: 'http://id.example.invalid/application/o/everflow/' })).toThrow(/oidc.issuer/);
  expect(() => oidcSettings(undefined, 'a', env)).toThrow(/oidc.public-origin/);
});

test('password fallback flag: on by default, off only when asked, anything else refused', () => {
  expect(passwordLogin({})).toBe(true);
  expect(passwordLogin({ EVERFLOW_PASSWORD_LOGIN: 'on' })).toBe(true);
  expect(passwordLogin({ EVERFLOW_PASSWORD_LOGIN: ' OFF ' })).toBe(false);
  expect(() => passwordLogin({ EVERFLOW_PASSWORD_LOGIN: 'no' })).toThrow(/login.password-flag/);
  expect(openPath('GET', '/oidc/start')).toBe(true);
  expect(openPath('GET', '/oidc/callback')).toBe(true);
  expect(openPath('POST', '/oidc/callback')).toBe(false);
});

test('session kinds: EverID and password sessions are bound to their own account, the fallback off ends password sessions', () => {
  const account = { user: 'me@example.invalid', hash: hashPassword('x') }, now = Date.UTC(2026, 10, 19);
  const both = new Sessions(KEY, account, { everid: 'issuer\0client\0me@example.invalid' });
  const password = both.issue(now), everid = both.issue(now, 'o1');
  expect(password).toMatch(/^v1\./);
  expect(everid).toMatch(/^o1\./);
  expect(both.kind(password, now)).toBe('v1');
  expect(both.kind(everid, now)).toBe('o1');
  // the same signature under the other kind is not a session
  expect(both.valid('o1' + password.slice(2), now)).toBe(false);
  const off = new Sessions(KEY, account, { password: false, everid: 'issuer\0client\0me@example.invalid' });
  expect(off.valid(password, now)).toBe(false);
  expect(off.valid(everid, now)).toBe(true);
  expect(() => off.issue(now)).toThrow(/login.kind-v1/);
  // a changed password keeps EverID sessions, a changed EverID client keeps password sessions
  expect(new Sessions(KEY, { ...account, hash: hashPassword('y') }, { everid: 'issuer\0client\0me@example.invalid' }).valid(everid, now)).toBe(true);
  const moved = new Sessions(KEY, account, { everid: 'issuer\0other\0me@example.invalid' });
  expect(moved.valid(everid, now)).toBe(false);
  expect(moved.valid(password, now)).toBe(true);
  expect(() => new Sessions(KEY, account).issue(now, 'o1')).toThrow(/login.kind-o1/);
});

test('pending sign-in cookie is signed and expires', () => {
  const flow = { state: 's', nonce: 'n', verifier: 'v', next: '/', expires: 2_000 };
  const sealed = sealFlow(KEY, flow);
  expect(openFlow(KEY, sealed, 1_000)).toEqual(flow);
  expect(openFlow(KEY, sealed, 2_000)).toBeUndefined();
  expect(openFlow(Buffer.alloc(32, 1), sealed, 1_000)).toBeUndefined();
  const [body, mac] = sealed.split('.');
  expect(openFlow(KEY, `${b64({ ...flow, next: 'https://evil.example' })}.${mac}`, 1_000)).toBeUndefined();
  expect(openFlow(KEY, `${body}x.${mac}`, 1_000)).toBeUndefined();
  expect(openFlow(KEY, undefined)).toBeUndefined();
});

test('ID token claims: issuer, audience, expiry, nonce and subject are checked', () => {
  const now = 1_000_000_000_000, exp = now / 1000 + 60;
  const ok = { iss: 'https://i/', aud: CLIENT, sub: 'u', nonce: 'n', exp };
  expect(idClaims(jwt(ok), 'https://i/', CLIENT, 'n', now).sub).toBe('u');
  expect(idClaims(jwt({ ...ok, aud: [CLIENT, 'x'], azp: CLIENT }), 'https://i/', CLIENT, 'n', now).sub).toBe('u');
  for (const bad of [{ iss: 'https://j/' }, { aud: 'other' }, { aud: [CLIENT, 'x'] }, { exp: now / 1000 - 1 }, { nonce: 'm' }, { sub: '' }]) {
    expect(() => idClaims(jwt({ ...ok, ...bad }), 'https://i/', CLIENT, 'n', now)).toThrow();
  }
  expect(() => idClaims('not-a-jwt', 'https://i/', CLIENT, 'n', now)).toThrow(/readable/);
  expect(() => idClaims(undefined, 'https://i/', CLIENT, 'n', now)).toThrow(/readable/);
});

test('EverID flow: start, callback, group and account rule decide, state and PKCE are bound to the browser', async () => {
  const provider = issuer();
  servers.push(provider.server);
  const base = await provider.listen();
  const settings: OidcSettings = { issuer: base, clientId: CLIENT, clientSecret: SECRET, redirectUri: `${ORIGIN}/oidc/callback`, postLogoutUri: `${ORIGIN}/`,
    email: 'me@example.invalid', group: 'app-flow', adminGroup: 'everid-admins', subjects: ['user-7'] };
  const oidc = new Oidc(settings, KEY);
  const signIn = async (next = '/') => {
    const started = await oidc.start(next);
    expect(new URL(started.location).searchParams.get('redirect_uri')).toBe(`${ORIGIN}/oidc/callback`);
    return { params: provider.authorize(started.location), cookie: started.cookie };
  };

  const first = await signIn('/overview');
  const signedIn = await oidc.finish(first.params, first.cookie);
  expect(signedIn.next).toBe('/overview');
  expect(signedIn.idToken.split('.')).toHaveLength(3);
  // RP-initiated logout: EverID's end-session with the hint, back to the page
  const out = new URL((await oidc.logout(signedIn.idToken))!);
  expect(out.href.startsWith(`${base}end-session/`)).toBe(true);
  expect(out.searchParams.get('id_token_hint')).toBe(signedIn.idToken);
  expect(out.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/`);
  expect(new URL((await oidc.logout('not a token'))!).searchParams.has('id_token_hint')).toBe(false);
  // a code is used once
  await expect(oidc.finish(first.params, first.cookie)).rejects.toMatchObject({ code: 'everid.failed' });

  const other = await signIn(), mine = await signIn();
  await expect(oidc.finish(other.params, mine.cookie)).rejects.toMatchObject({ code: 'everid.expired' });
  await expect(oidc.finish(mine.params, undefined)).rejects.toMatchObject({ code: 'everid.expired' });
  await expect(oidc.finish(new URLSearchParams({ state: new URLSearchParams(mine.params).get('state')!, error: 'access_denied' }), mine.cookie))
    .rejects.toMatchObject({ code: 'everid.denied' });

  // group denied: an account outside app-flow, even an admin with the account's email
  provider.state.groups = ['app-drive', 'everid-admins'];
  const noGroup = await signIn();
  await expect(oidc.finish(noGroup.params, noGroup.cookie)).rejects.toMatchObject({ code: 'everid.denied' });
  // email alone (never verified by EverID) is not enough outside everid-admins
  provider.state.groups = ['app-flow'];
  const plainEmail = await signIn();
  await expect(oidc.finish(plainEmail.params, plainEmail.cookie)).rejects.toMatchObject({ code: 'everid.denied' });
  // group allowed by sub: a listed subject holds the account whatever its email
  provider.state.sub = 'user-7';
  provider.state.email = 'other@example.invalid';
  const bySub = await signIn();
  expect((await oidc.finish(bySub.params, bySub.cookie)).next).toBe('/');
  provider.state.groups = ['everid-admins'];
  const subNoGroup = await signIn();
  await expect(oidc.finish(subNoGroup.params, subNoGroup.cookie)).rejects.toMatchObject({ code: 'everid.denied' });
  provider.state.sub = 'user-1';
  provider.state.groups = ['app-flow', 'everid-admins'];
  const otherEmail = await signIn();
  await expect(oidc.finish(otherEmail.params, otherEmail.cookie)).rejects.toMatchObject({ code: 'everid.denied' });
  // group allowed by admin email, compared case-insensitively
  provider.state.email = 'ME@example.invalid';
  const upper = await signIn();
  expect((await oidc.finish(upper.params, upper.cookie)).next).toBe('/');

  provider.state.nonce = 'replayed';
  const replay = await signIn();
  await expect(oidc.finish(replay.params, replay.cookie)).rejects.toMatchObject({ code: 'everid.failed' });
  provider.state.nonce = undefined;
  provider.state.infoSub = 'user-2';
  const swapped = await signIn();
  await expect(oidc.finish(swapped.params, swapped.cookie)).rejects.toMatchObject({ code: 'everid.failed' });
  provider.state.infoSub = undefined;

  const cold = new Oidc(settings, KEY);
  provider.state.down = true;
  await expect(cold.start('/')).rejects.toMatchObject({ code: 'everid.unavailable' });
});

test('served page: own form, EverID behind it, callback still served, local sign-out', async () => {
  const provider = issuer();
  servers.push(provider.server);
  const base = await provider.listen();
  const fixture = webFixture();
  appendFileSync(fixture.config, `[web]\npublic_origin = "${ORIGIN}"\n`);
  const hash = hashPassword('synthetic secret');
  const env = (flag: string) => ({ TEST_INSTANCE_CONFIG: fixture.config, EVERFLOW_LOGIN_USER: 'me@example.invalid', EVERFLOW_LOGIN_HASH: hash,
    OIDC_ISSUER: base, OIDC_CLIENT_ID: CLIENT, OIDC_CLIENT_SECRET: SECRET, EVERFLOW_PASSWORD_LOGIN: flag });
  const pub = (port: number, path: string, options: Parameters<typeof http>[2] = {}) => http(port, path, { ...options, headers: { host: HOST, ...options.headers } });
  const login = (port: number) => pub(port, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'me@example.invalid', password: 'synthetic secret' }),
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' } });

  let everidCookie = '';
  const server = await launch('web-process.ts', [], env('on'));
  try {
    // the app's own form: no EverID wording, no link to it
    const page = await pub(server.port, '/login');
    expect(page.text).toContain('type="password"');
    expect(page.text).not.toMatch(/everid/i);
    const start = await pub(server.port, '/oidc/start?next=%2Foverview');
    expect(start.status).toBe(303);
    expect(start.headers.location!.startsWith(base.replace('everflow/', 'authorize/'))).toBe(true);
    const flow = String(start.headers['set-cookie']);
    expect(flow).toMatch(/^everflow_oidc=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Path=\/oidc\/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
    const params = provider.authorize(start.headers.location!);

    const stray = await pub(server.port, `/oidc/callback?${params}`);
    expect(stray.status).toBe(303);
    expect(stray.headers.location).toBe('/login?error=everid.expired');

    const done = await pub(server.port, `/oidc/callback?${params}`, { headers: { cookie: flow.split(';')[0]! } });
    expect(done.status).toBe(303);
    expect(done.headers.location).toBe('/overview');
    const set = done.headers['set-cookie']!;
    expect(set[2]).toMatch(/^everflow_session=o1\.\d{13}\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    const hint = set[1]!.split(';')[0]!;
    everidCookie = set[2]!.split(';')[0]!;
    expect((await pub(server.port, '/api/state', { headers: { cookie: everidCookie } })).status).toBe(200);

    // signing out stays on Everflow: no EverID end-session for the browser
    const out = await pub(server.port, '/api/logout', { method: 'POST', headers: { origin: ORIGIN, cookie: `${everidCookie}; ${hint}` } });
    expect(out.status).toBe(204);
    expect(out.headers['x-everflow-logout']).toBeUndefined();
    expect(String(out.headers['set-cookie'])).toContain('everflow_idt=; Path=/api/logout');

    // the form goes to EverID behind the page; this fake EverID has no sign-in flow, so it fails closed
    const unavailable = await login(server.port);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers['set-cookie']).toBeUndefined();
  } finally { await server.close(); }

  const off = await launch('web-process.ts', [], env('off'));
  try {
    const page = await pub(off.port, '/login');
    expect(page.text).toContain('type="password"');
    // the local password is never the check once EverID is configured
    expect((await login(off.port)).status).toBe(503);
    // an EverID session from before the restart survives it
    expect((await pub(off.port, '/api/state', { headers: { cookie: everidCookie } })).status).toBe(200);
  } finally { await off.close(); }

  await expect(launch('web-process.ts', [], { ...env('off'), OIDC_ISSUER: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '' })).rejects.toThrow(/login.none/);
  await expect(launch('web-process.ts', [], { ...env('on'), OIDC_CLIENT_SECRET: '' })).rejects.toThrow(/oidc.client-required/);
}, 240_000);
