import type { IncomingMessage, ServerResponse } from 'node:http';
import { COOKIE, cookieValue, openPath, safeNext, SESSION_MS } from './login.ts';
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

const cookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** Sign-in gate for a request under the public host. True when it answered the request itself. */
export function signIn(request: IncomingMessage, response: ServerResponse, current: WebInstance, login: Login): boolean {
  const url = new URL(request.url ?? '/', 'http://everflow.invalid');
  const path = url.pathname, method = request.method ?? 'GET';
  const json = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify({ error: { code, message } }));
  const sameOrigin = request.headers.origin?.toLowerCase() === current.config.web.public_origin;

  if (path === '/api/login' && method === 'POST') {
    if (!sameOrigin) { json(403, 'login.origin', 'Origin rejected'); return true; }
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
        response.writeHead(204, { 'set-cookie': cookie(login.sessions.issue(), SESSION_MS / 1000) }).end();
      } else {
        login.limiter.fail(who);
        json(401, 'login.invalid', 'Wrong email or password');
      }
    }, () => { if (!response.headersSent) json(400, 'login.input', 'Email and password are required'); });
    return true;
  }
  if (path === '/api/logout' && method === 'POST') {
    if (!sameOrigin) { json(403, 'login.origin', 'Origin rejected'); return true; }
    response.writeHead(204, { 'set-cookie': cookie('', 0) }).end();
    return true;
  }
  const signed = login.sessions.valid(cookieValue(request.headers.cookie));
  if (signed && method === 'GET' && path === '/login') {
    response.writeHead(303, { location: safeNext(url.searchParams.get('next')) }).end();
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
