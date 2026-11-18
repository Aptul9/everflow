import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebInstance } from './instance.ts';
import { signedIn } from './login-http.ts';

// Gate of the chat host ([web] chat_origin). Caddy asks it on every request to that host (forward_auth, Host forced to
// loopback): with a valid page session it answers 204 and the OpenChamber client token, which Caddy puts upstream as
// Authorization; without one, 401 and where to sign in. The token is OpenChamber's own revocable remote-client credential,
// minted with the UI password the daemon already has, kept owner-only next to the database and reused across restarts.
export const GATE_PATH = '/api/chat-gate';
export const GATE_HEADER = 'x-everflow-chat-authorization';
const PROBE_MS = 60_000;
// OpenChamber gives a trusted-device token 7 days by default; a new one is minted a day before that runs out
const RENEW_MS = 24 * 60 * 60 * 1000;

interface Stored { token: string; expires_at: string | null }

// Plain errors with status and code: the page's routes run in Next's module graph, with their own copy of every class
const failure = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });

export class ChatToken {
  private readonly file: string;
  private readonly url: string;
  private readonly password: () => string;
  private readonly fetch: typeof globalThis.fetch;
  private stored: Stored | null | undefined;
  private checkedAt = 0;
  private pending: Promise<string> | undefined;
  private failure: { at: number; error: unknown } | undefined;
  constructor(file: string, url: string, password: () => string, fetch: typeof globalThis.fetch = globalThis.fetch) {
    this.file = file; this.url = url.replace(/\/$/, ''); this.password = password; this.fetch = fetch;
  }

  private read(): Stored | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Stored>;
      return typeof value.token === 'string' && value.token.startsWith('oc_client_') ? { token: value.token, expires_at: typeof value.expires_at === 'string' ? value.expires_at : null } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private write(value: Stored): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }

  private async mint(): Promise<string> {
    const response = await this.fetch(`${this.url}/auth/session`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: this.password(), trustDevice: true, issueClientToken: true, clientLabel: 'Everflow web', clientKind: 'web',
        dedupeKey: 'everflow-web', deviceName: 'Everflow web' }) });
    const result = (response.ok ? await response.json() : await response.body?.cancel()) as { clientToken?: unknown; client?: { expiresAt?: unknown } } | undefined;
    if (!response.ok || typeof result?.clientToken !== 'string' || !result.clientToken.startsWith('oc_client_')) {
      throw Object.assign(new Error(`OpenChamber gave no client token (HTTP ${response.status})`), { status: response.status });
    }
    this.stored = { token: result.clientToken, expires_at: typeof result.client?.expiresAt === 'string' ? result.client.expiresAt : null };
    this.write(this.stored);
    this.checkedAt = Date.now();
    return this.stored.token;
  }

  // 200: still good; 401: revoked, expired or OpenChamber's store was reset
  private async probe(token: string): Promise<boolean> {
    const response = await this.fetch(`${this.url}/auth/session`, { redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    await response.body?.cancel();
    if (response.status === 401) return false;
    if (!response.ok) throw Object.assign(new Error(`OpenChamber session check HTTP ${response.status}`), { status: response.status });
    return true;
  }

  /** A token OpenChamber accepted within the last minute, minted again only when it answered 401 or the token is about to expire. */
  token(now = Date.now()): Promise<string> {
    // a refused or failed mint waits a minute: every gate request retrying would spend OpenChamber's login attempts for loopback,
    // which the daemon's own chat sign-in shares
    if (this.failure && now - this.failure.at < PROBE_MS) return Promise.reject(this.failure.error);
    return this.pending ??= (async () => {
      if (this.stored === undefined) this.stored = this.read();
      const current = this.stored;
      const expires = Date.parse(current?.expires_at ?? '');
      if (!current || Number.isFinite(expires) && expires - now < RENEW_MS) return this.mint();
      if (now - this.checkedAt < PROBE_MS) return current.token;
      if (!(await this.probe(current.token))) return this.mint();
      this.checkedAt = now;
      return current.token;
    })().then((token) => { this.failure = undefined; return token; }, (error: unknown) => { this.failure = { at: now, error }; throw error; })
      .finally(() => { this.pending = undefined; });
  }

  /**
   * The folder OpenChamber keeps the session in, registered as one of its projects first: its chat view (mini-chat.html)
   * finds a session only among the projects' sessions and otherwise shows an empty chat. Registering an existing project
   * changes nothing; the full UI does the same when it opens a session from a folder it does not list.
   */
  async open(session: string): Promise<string> {
    const headers = { authorization: `Bearer ${await this.token()}`, accept: 'application/json' };
    const call = (path: string, body?: unknown) => this.fetch(`${this.url}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const found = await call(`/api/session/${encodeURIComponent(session)}`);
    if (found.status === 404) { await found.body?.cancel(); throw failure(404, 'chat.not-found', `OpenChamber has no session ${session}`); }
    if (!found.ok) { await found.body?.cancel(); throw failure(502, 'chat.unavailable', `OpenChamber session lookup failed (HTTP ${found.status})`); }
    const directory = ((await found.json()) as { data?: { location?: { directory?: unknown } } }).data?.location?.directory;
    if (typeof directory !== 'string' || !directory) throw failure(502, 'chat.unavailable', `OpenChamber gave no folder for session ${session}`);
    const registered = await call('/api/projects/session-directory', { sessionId: session, directory });
    const result = await registered.json().catch(() => null) as { directory?: unknown } | null;
    if (registered.status === 403) throw failure(409, 'chat.untrusted', `OpenChamber asks to trust ${directory} before it opens this chat: open the chat once in OpenChamber`);
    if (!registered.ok) throw failure(502, 'chat.unavailable', `OpenChamber could not add ${directory} to its projects (HTTP ${registered.status})`);
    // a session recorded under a symlinked spelling of its folder comes back under the canonical one
    return typeof result?.directory === 'string' && result.directory ? result.directory : directory;
  }

  /** A JSON read from OpenChamber's API with the client token: 404 as chat.not-found, any other failure as chat.unavailable. */
  async get(path: string): Promise<unknown> {
    const response = await this.fetch(`${this.url}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${await this.token()}`, accept: 'application/json' } });
    if (response.status === 404) { await response.body?.cancel(); throw failure(404, 'chat.not-found', `OpenChamber has no ${path.split('?')[0]}`); }
    if (!response.ok) { await response.body?.cancel(); throw failure(502, 'chat.unavailable', `OpenChamber read failed (HTTP ${response.status})`); }
    return response.json();
  }

  /** OpenChamber's response to a page request with the client token, as it came (no redirect followed): for the chat bridge. */
  async page(path: string): Promise<Response> {
    const token = await this.token();
    return this.fetch(`${this.url}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { authorization: 'Bearer ' + token, accept: 'text/html' } });
  }
}

/** Answers GATE_PATH on the loopback listener. Under any other Host the caller answers 404. */
export function chatGate(request: IncomingMessage, response: ServerResponse, current: WebInstance): void {
  const login = current.login, chat = current.chat, chatOrigin = current.config.web.chat_origin, publicOrigin = current.config.web.public_origin;
  const notFound = () => { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found'); };
  // only Caddy's forward_auth for the chat host, which names that host in X-Forwarded-Host
  if (!login || !chat || !chatOrigin || !publicOrigin || `https://${String(request.headers['x-forwarded-host'] ?? '').toLowerCase()}` !== chatOrigin) { notFound(); return; }
  if (!signedIn(request, login)) {
    const uri = String(request.headers['x-forwarded-uri'] ?? '/');
    const back = chatOrigin + (/^\/(?![/\\])[^\s]*$/.test(uri) ? uri : '/');
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'x-everflow-login': `${publicOrigin}/login?next=${encodeURIComponent(back)}` }).end('Sign in required');
    return;
  }
  void chat.token().then((token) => { response.writeHead(204, { [GATE_HEADER]: `Bearer ${token}` }).end(); }, () => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('OpenChamber unavailable');
  });
}
