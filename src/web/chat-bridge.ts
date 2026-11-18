import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { WebInstance } from './instance.ts';
import { signedIn } from './login-http.ts';

// OpenChamber's chat view as the board frames it. The chat host sends /mini-chat.html and /everflow-bridge.js here (Caddy,
// after the gate, Host forced to loopback, path under BRIDGE_PREFIX): the view comes from OpenChamber with the client
// token, with one script tag added, and the script (everflow-bridge.js) tells the board about clicked file links and
// turns the view's desktop-only pop-out button into one that closes the dialog. Same rule as the gate: 404 under the
// public host and to any request that is not Caddy's for the chat host.
export const BRIDGE_PREFIX = '/api/chat-bridge';
export const BRIDGE_PAGE = '/mini-chat.html';
export const BRIDGE_SCRIPT = '/everflow-bridge.js';
// two levels below the build root both from src/web and from dist/web
const SCRIPT_FILE = fileURLToPath(new URL('../../src/web/everflow-bridge.js', import.meta.url));
const DROPPED = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'etag', 'last-modified']);

let script: Buffer | undefined;

/** The page's origin travels in the script address: the bridge posts only to it. */
export function bridgeTag(publicOrigin: string): string {
  return `<script src="${BRIDGE_SCRIPT}?parent=${encodeURIComponent(publicOrigin)}" defer></script>`;
}

/** The chat view with the bridge script before </head>, once. */
export function inject(html: string, publicOrigin: string): string {
  if (html.includes(`src="${BRIDGE_SCRIPT}`)) return html;
  const tag = bridgeTag(publicOrigin), at = html.search(/<\/head>/i);
  return at < 0 ? tag + html : html.slice(0, at) + tag + html.slice(at);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Shown in the dialog instead of an empty frame when OpenChamber does not answer. */
function errorPage(response: ServerResponse, message: string): void {
  response.writeHead(502, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chat unavailable</title>'
    + '<style>body{font:14px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#b42318;background:#fff}p{max-width:28rem;padding:1rem}</style></head>'
    + `<body><p role="alert">The chat could not be loaded: ${escapeHtml(message)}. Close this window and open the chat again.</p></body></html>`);
}

/** Answers BRIDGE_PREFIX paths on the loopback listener. Under the public host the caller answers 404. */
export async function chatBridge(request: IncomingMessage, response: ServerResponse, current: WebInstance): Promise<void> {
  const login = current.login, chat = current.chat, chatOrigin = current.config.web.chat_origin, publicOrigin = current.config.web.public_origin;
  const notFound = () => { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found'); };
  if (!login || !chat || !chatOrigin || !publicOrigin || `https://${String(request.headers['x-forwarded-host'] ?? '').toLowerCase()}` !== chatOrigin
    || request.method !== 'GET' && request.method !== 'HEAD') { notFound(); return; }
  // Caddy asked the gate already; the cookie is checked again so that only a signed-in browser's request gets the view
  if (!signedIn(request, login)) { response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('Sign in required'); return; }
  const url = new URL(request.url ?? '/', 'http://everflow.invalid');
  const path = url.pathname.slice(BRIDGE_PREFIX.length);
  if (path === BRIDGE_SCRIPT) {
    try { script ??= fs.readFileSync(SCRIPT_FILE); } catch { notFound(); return; }
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(request.method === 'HEAD' ? undefined : script);
    return;
  }
  if (path !== BRIDGE_PAGE) { notFound(); return; }
  let upstream: Response;
  try { upstream = await chat.page(`${BRIDGE_PAGE}${url.search}`); } catch (error) {
    errorPage(response, error instanceof Error && error.message ? error.message : 'OpenChamber unavailable');
    return;
  }
  const headers: Record<string, string | string[]> = {};
  upstream.headers.forEach((value, name) => { if (!DROPPED.has(name)) headers[name] = value; });
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  let body: Buffer | string;
  try {
    const bytes = Buffer.from(await upstream.arrayBuffer());
    body = upstream.status === 200 && /^text\/html\b/i.test(upstream.headers.get('content-type') ?? '') ? inject(bytes.toString('utf8'), publicOrigin) : bytes;
  } catch (error) {
    errorPage(response, error instanceof Error && error.message ? error.message : 'OpenChamber unavailable');
    return;
  }
  response.writeHead(upstream.status, { ...headers, 'cache-control': 'no-store' }).end(request.method === 'HEAD' ? undefined : body);
}
