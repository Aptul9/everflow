import type { IncomingMessage, ServerResponse } from 'node:http';
import { COOKIE, cookieDomain, cookieValue, cookieValues, openPath, safeNext, SESSION_MS } from './login.ts';
import { CALLBACK_PATH, FLOW_MS, HINT_COOKIE, ID_TOKEN, ID_TOKEN_MAX, OIDC_COOKIE, START_PATH } from './oidc.ts';
import type { WebInstance } from './instance.ts';

type Login = NonNullable<WebInstance['login']>;

// Caddy is the only peer of the loopback listener and replaces X-Forwarded-For with the client address; the last entry is it
function client(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  const value = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').map((part) => part.trim()).filter(Boolean).at(-1);
  return value ?? request.socket.remoteAddress ?? 'unknown';
}

function body(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('login.body-size')); request.destroy(); } else chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

const cookie = (value: string, maxAge: number, domain?: string) =>
  `${COOKIE}=${value}; Path=/;${domain ? ` Domain=${domain};` : ''} HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** The session cookie: for the public host and its chat host when [web] chat_origin sits under it, otherwise host-only. */
export function sessionCookies(current: WebInstance, value: string | null): string[] {
  const domain = cookieDomain(current.config.web.public_origin, current.config.web.chat_origin);
  if (value !== null) return [cookie(value, SESSION_MS / 1000, domain)];
  // signing out clears both, since a session from before chat_origin was set is host-only
  return domain ? [cookie('', 0), cookie('', 0, domain)] : [cookie('', 0)];
}

export function signedIn(request: IncomingMessage, login: Login): boolean {
  return cookieValues(request.headers.cookie).some((value) => login.sessions.valid(value));
}

// The pending EverID sign-in: host-only, only sent back to the callback, gone after it
const flowCookie = (value: string, maxAge: number) => `${OIDC_COOKIE}=${value}; Path=${CALLBACK_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
// The ID token of an EverID session, the hint EverID's end-session wants: host-only, only sent back to the sign-out
const hintCookie = (value: string, maxAge: number) => `${HINT_COOKIE}=${value}; Path=/api/logout; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
// Prevent the provider's post-logout redirect to / from immediately starting another SSO session.
const LOGGED_OUT = 'everflow_signed_out';
const loggedOutCookie = (clear = false) => `${LOGGED_OUT}=${clear ? '' : '1'}; Path=/; HttpOnly; Secure; SameSite=Lax${clear ? '; Max-Age=0' : ''}`;
const EVERID_CODES = new Set(['everid.denied', 'everid.expired', 'everid.unavailable', 'everid.failed']);

/** GET /oidc/start (to EverID, with where to come back to) and GET /oidc/callback (EverID's answer: a session, or the sign-in page and why). */
function everid(request: IncomingMessage, response: ServerResponse, current: WebInstance, login: Login, url: URL): void {
  const back = (code: string, next?: string, cookies: string[] = []) => {
    const query = new URLSearchParams({ error: EVERID_CODES.has(code) ? code : 'everid.failed', ...(next && next !== '/' ? { next } : {}) });
    response.writeHead(303, { location: `/login?${query}`, ...(cookies.length ? { 'set-cookie': cookies } : {}) }).end();
  };
  const oidc = login.oidc;
  if (!oidc) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
  const chatOrigin = current.config.web.chat_origin;
  if (url.pathname === START_PATH) {
    const next = safeNext(url.searchParams.get('next'), chatOrigin);
    void oidc.start(next).then(({ location, cookie }) => {
      response.writeHead(303, { location, 'set-cookie': [flowCookie(cookie, FLOW_MS / 1000), loggedOutCookie(true)] }).end();
    }, (error: unknown) => {
      process.stderr.write(JSON.stringify({ event: 'everid.start', error: (error as Error).message }) + '\n');
      if (!response.headersSent) back((error as { code?: string }).code ?? 'everid.failed', next);
    });
    return;
  }
  const clear = flowCookie('', 0);
  void oidc.finish(url.searchParams, cookieValue(request.headers.cookie, OIDC_COOKIE)).then(({ next, idToken }) => {
    const hint = ID_TOKEN.test(idToken) && idToken.length <= ID_TOKEN_MAX ? [hintCookie(idToken, SESSION_MS / 1000)] : [];
    response.writeHead(303, { location: safeNext(next, chatOrigin), 'set-cookie': [clear, ...hint, ...sessionCookies(current, login.sessions.issue(Date.now(), 'o1'))] }).end();
  }, (error: unknown) => {
    process.stderr.write(JSON.stringify({ event: 'everid.callback', error: (error as Error).message }) + '\n');
    if (!response.headersSent) back((error as { code?: string }).code ?? 'everid.failed', undefined, [clear]);
  });
}

/** Sign-in gate for a request under the public host. True when it answered the request itself. */
export function signIn(request: IncomingMessage, response: ServerResponse, current: WebInstance, login: Login): boolean {
  const url = new URL(request.url ?? '/', 'http://everflow.invalid');
  const path = url.pathname, method = request.method ?? 'GET';
  const json = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify({ error: { code, message } }));
  const sameOrigin = request.headers.origin?.toLowerCase() === current.config.web.public_origin;

  if (path === '/api/login' && method === 'POST') {
    if (!sameOrigin) { json(403, 'login.origin', 'Origin rejected'); return true; }
    if (!login.password) { json(403, 'login.password-off', 'Password sign-in is off, sign in with EverID'); return true; }
    const who = client(request), wait = login.limiter.retryAfter(who);
    if (wait > 0) { json(429, 'login.locked', 'Too many attempts, try again later', { 'retry-after': String(Math.ceil(wait / 1000)) }); return true; }
    void body(request, 4096).then((text) => {
      let input: { email?: unknown; password?: unknown };
      try { input = JSON.parse(text) as typeof input; } catch { input = {}; }
      if (typeof input.email !== 'string' || typeof input.password !== 'string' || input.email.length > 256 || input.password.length > 1024) {
        json(400, 'login.input', 'Email and password are required'); return;
      }
      if (login.check(input.email.trim(), input.password)) {
        login.limiter.clear(who);
        response.writeHead(204, { 'set-cookie': sessionCookies(current, login.sessions.issue()) }).end();
      } else {
        login.limiter.fail(who);
        json(401, 'login.invalid', 'Wrong email or password');
      }
    }, () => { if (!response.headersSent) json(400, 'login.input', 'Email and password are required'); });
    return true;
  }
  if (path === '/api/logout' && method === 'POST') {
    if (!sameOrigin) { json(403, 'login.origin', 'Origin rejected'); return true; }
    const cookies = [...sessionCookies(current, null), ...(login.oidc ? [hintCookie('', 0), loggedOutCookie()] : [])];
    // after an EverID session the page goes on to EverID's end-session (x-everflow-logout), which comes back to the page
    const everidSession = cookieValues(request.headers.cookie).some((value) => login.sessions.kind(value) === 'o1');
    if (!login.oidc || !everidSession) { response.writeHead(204, { 'set-cookie': cookies }).end(); return true; }
    void login.oidc.logout(cookieValue(request.headers.cookie, HINT_COOKIE)).then((to) => {
      response.writeHead(204, { 'set-cookie': cookies, ...(to ? { 'x-everflow-logout': to } : {}) }).end();
    }, () => { if (!response.headersSent) response.writeHead(204, { 'set-cookie': cookies }).end(); });
    return true;
  }
  const signed = signedIn(request, login);
  if (method === 'GET' && (path === START_PATH || path === CALLBACK_PATH)) {
    everid(request, response, current, login, url);
    return true;
  }
  if (signed && method === 'GET' && path === '/login') {
    // A session from before chat_origin was set is host-only and never reaches the chat host: renewing it here, with the
    // kind it was opened with, gives it the domain, so the chat host's redirect to this page cannot loop
    const kind = cookieValues(request.headers.cookie).map((value) => login.sessions.kind(value)).find((found) => found !== undefined)!;
    const renew = cookieDomain(current.config.web.public_origin, current.config.web.chat_origin) ? { 'set-cookie': sessionCookies(current, login.sessions.issue(Date.now(), kind)) } : {};
    response.writeHead(303, { location: safeNext(url.searchParams.get('next'), current.config.web.chat_origin), ...renew }).end();
    return true;
  }
  if (!signed && method === 'GET' && path === '/' && login.oidc && cookieValue(request.headers.cookie, LOGGED_OUT) === '1') {
    response.writeHead(303, { location: '/login?logged_out=1' }).end();
    return true;
  }
  if (!signed && method === 'GET' && path === '/login' && login.oidc && !url.searchParams.has('error') && !url.searchParams.has('logged_out')
    && !(cookieValue(request.headers.cookie, LOGGED_OUT) === '1' && !url.searchParams.has('next'))) {
    const next = safeNext(url.searchParams.get('next'), current.config.web.chat_origin);
    response.writeHead(303, { location: `${START_PATH}?next=${encodeURIComponent(next)}` }).end();
    return true;
  }
  if (signed || openPath(method, path)) return false;
  if (method === 'GET' && !path.startsWith('/api/')) {
    response.writeHead(303, { location: `/login?next=${encodeURIComponent(safeNext(path + url.search))}` }).end();
    return true;
  }
  json(401, 'login.required', 'Sign in required', { 'x-everflow-login': 'required' });
  return true;
}
