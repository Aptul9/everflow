import { SourceError } from './source.ts';
import type { Source } from './source.ts';

// The OE Copilot endpoint every OE-hosted source reads through (communication service /everflow/*): one URL, one read-only
// token. The daemon hands both to the watcher in its environment, never in its arguments.
export interface OeEndpoint { url: string; token: string }

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

export function oeEndpoint(source: Source, prefix: string, env: NodeJS.ProcessEnv = process.env): OeEndpoint {
  const fail = () => new SourceError(source, `${prefix}.oe-config`);
  const raw = env.EVERFLOW_OE_URL?.trim(), token = env.EVERFLOW_OE_TOKEN?.trim();
  if (!raw || !token || !/^[\x21-\x7e]+$/.test(token)) throw fail();
  let url: URL;
  try { url = new URL(raw); } catch { throw fail(); }
  if (url.username || url.password || url.search || url.hash) throw fail();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.has(url.hostname))) throw fail();
  return { url: url.href.replace(/\/+$/, ''), token };
}

// One call to <url>/everflow/<route>. Transport failures carry the caller's prefix: http-failed (network error, redirect
// or non-2xx from the endpoint itself, status kept), timeout, aborted, result-limit (body past maxBytes, never cut),
// response-json.
export async function oeRequest(source: Source, prefix: string, endpoint: OeEndpoint, route: string,
  init: { method: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> }, signal?: AbortSignal,
  limits: { timeoutMs?: number; maxBytes?: number } = {}, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const timeoutMs = limits.timeoutMs ?? 90_000, maxBytes = limits.maxBytes ?? 64 * 1024 * 1024;
  if (signal?.aborted) throw new SourceError(source, `${prefix}.aborted`);
  const url = new URL(`${endpoint.url}/everflow/${route}`);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const failure = (error: unknown): SourceError => {
    if (error instanceof SourceError) return error;
    if (signal?.aborted) return new SourceError(source, `${prefix}.aborted`);
    if (timeout.aborted) return new SourceError(source, `${prefix}.timeout`);
    return new SourceError(source, `${prefix}.http-failed`);
  };
  let text: string;
  try {
    const response = await fetchImpl(url, { method: init.method, redirect: 'error', signal: combined,
      headers: { Authorization: `Bearer ${endpoint.token}`, Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SourceError(source, `${prefix}.http-failed`, undefined, response.status);
    }
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new SourceError(source, `${prefix}.result-limit`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new SourceError(source, `${prefix}.result-limit`);
        }
        chunks.push(value);
      }
    }
    text = Buffer.concat(chunks).toString('utf8');
  } catch (error) { throw failure(error); }
  try { return JSON.parse(text); } catch { throw new SourceError(source, `${prefix}.response-json`); }
}
