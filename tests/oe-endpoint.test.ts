import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { oeEndpoint, oeRequest } from '../src/watchers/oe-endpoint.ts';
import { SourceError } from '../src/watchers/source.ts';

const TOKEN = 'everflow-token-0123456789abcdef0123456789';
const servers: { close(): void; closeAllConnections(): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); }
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler(req, res, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/communication`;
}

async function failure(promise: Promise<unknown>): Promise<SourceError> {
  try { await promise; } catch (error) { if (error instanceof SourceError) return error; throw error; }
  throw new Error('no failure');
}

test('sends the bearer and json body to the everflow route', async () => {
  const seen: { method: string | undefined; url: string | undefined; auth: string | undefined; type: string | undefined; body: string }[] = [];
  const url = await serve((req, res, body) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ responses: [{ status: 200, body: '{}' }] }));
  });
  const endpoint = { url, token: TOKEN };
  expect(await oeRequest('oemail', 'oemail', endpoint, 'agent', { method: 'POST', body: { requests: [{ path: '/api/communication/accounts' }] } }))
    .toEqual({ responses: [{ status: 200, body: '{}' }] });
  await oeRequest('teamsrelay', 'relay', endpoint, 'teams', { method: 'GET', query: { since: '1790431000000', max_rows: '10000' } });
  expect(seen).toEqual([
    { method: 'POST', url: '/communication/everflow/agent', auth: `Bearer ${TOKEN}`, type: 'application/json', body: '{"requests":[{"path":"/api/communication/accounts"}]}' },
    { method: 'GET', url: '/communication/everflow/teams?since=1790431000000&max_rows=10000', auth: `Bearer ${TOKEN}`, type: undefined, body: '' },
  ]);
});

test('missing url or token is <prefix>.oe-config, and so is a url that is not https or local http', () => {
  for (const env of [{}, { EVERFLOW_OE_URL: 'https://teams.example/communication' }, { EVERFLOW_OE_TOKEN: TOKEN },
    { EVERFLOW_OE_URL: 'ftp://teams.example/', EVERFLOW_OE_TOKEN: TOKEN }, { EVERFLOW_OE_URL: 'http://example.com/communication', EVERFLOW_OE_TOKEN: TOKEN },
    { EVERFLOW_OE_URL: 'https://u:p@teams.example/', EVERFLOW_OE_TOKEN: TOKEN }, { EVERFLOW_OE_URL: 'nonsense', EVERFLOW_OE_TOKEN: TOKEN },
    { EVERFLOW_OE_URL: 'https://teams.example/communication', EVERFLOW_OE_TOKEN: 'bad token\n' }]) {
    expect(() => oeEndpoint('slack', 'slack', env), JSON.stringify(env)).toThrow(expect.objectContaining({ code: 'slack.oe-config', source: 'slack' }));
  }
  expect(oeEndpoint('oemail', 'oemail', { EVERFLOW_OE_URL: 'https://teams.example/communication/', EVERFLOW_OE_TOKEN: ` ${TOKEN}\n` }))
    .toEqual({ url: 'https://teams.example/communication', token: TOKEN });
  expect(oeEndpoint('oemail', 'oemail', { EVERFLOW_OE_URL: 'http://127.0.0.1:8190', EVERFLOW_OE_TOKEN: TOKEN }).url).toBe('http://127.0.0.1:8190');
  expect(oeEndpoint('oemail', 'oemail', { EVERFLOW_OE_URL: 'http://localhost:8190/', EVERFLOW_OE_TOKEN: TOKEN }).url).toBe('http://localhost:8190');
});

test('401 is http-failed with status 401, 502 with 502, connection refused without a status', async () => {
  let status = 401;
  const url = await serve((_req, res) => { res.statusCode = status; res.end('{"error":"no"}'); });
  const endpoint = { url, token: 'wrong' };
  let error = await failure(oeRequest('teamsrelay', 'relay', endpoint, 'teams', { method: 'GET' }));
  expect([error.code, error.status, error.source]).toEqual(['relay.http-failed', 401, 'teamsrelay']);
  status = 502;
  error = await failure(oeRequest('slack', 'slack', endpoint, 'slack', { method: 'POST', body: {} }));
  expect([error.code, error.status]).toEqual(['slack.http-failed', 502]);
  const closed = await serve(() => {});
  servers.pop()!.close();
  error = await failure(oeRequest('oemail', 'oemail', { url: closed, token: TOKEN }, 'agent', { method: 'POST', body: {} }));
  expect([error.code, error.status]).toEqual(['oemail.http-failed', undefined]);
});

test('a redirect is http-failed: the token never follows one', async () => {
  const seen: string[] = [];
  const url = await serve((req, res) => {
    seen.push(req.url!);
    if (req.url!.includes('agent')) { res.statusCode = 307; res.setHeader('location', '/elsewhere'); }
    res.end('{}');
  });
  const error = await failure(oeRequest('oemail', 'oemail', { url, token: TOKEN }, 'agent', { method: 'POST', body: {} }));
  expect(error.code).toBe('oemail.http-failed');
  expect(seen).toEqual(['/communication/everflow/agent']);
});

test('body over maxBytes is result-limit, never a cut parse', async () => {
  const url = await serve((_req, res) => { res.setHeader('content-type', 'application/json'); res.write('['); res.write('1,'.repeat(600)); res.end('1]'); });
  const error = await failure(oeRequest('teamsrelay', 'relay', { url, token: TOKEN }, 'teams', { method: 'GET' }, undefined, { maxBytes: 1000 }));
  expect(error.code).toBe('relay.result-limit');
  expect(await oeRequest('teamsrelay', 'relay', { url, token: TOKEN }, 'teams', { method: 'GET' }, undefined, { maxBytes: 1203 })).toHaveLength(601);
});

test('slow server is timeout, aborted signal is aborted, non-JSON body is response-json', async () => {
  const slow = await serve((_req, res) => { setTimeout(() => res.end('{}'), 2000); });
  expect((await failure(oeRequest('oemail', 'oemail', { url: slow, token: TOKEN }, 'agent', { method: 'POST', body: {} }, undefined, { timeoutMs: 100 }))).code).toBe('oemail.timeout');
  const controller = new AbortController();
  const pending = oeRequest('oemail', 'oemail', { url: slow, token: TOKEN }, 'agent', { method: 'POST', body: {} }, controller.signal);
  controller.abort();
  expect((await failure(pending)).code).toBe('oemail.aborted');
  const already = AbortSignal.abort();
  expect((await failure(oeRequest('slack', 'slack', { url: slow, token: TOKEN }, 'slack', { method: 'POST', body: {} }, already))).code).toBe('slack.aborted');
  const text = await serve((_req, res) => { res.end('<html>'); });
  expect((await failure(oeRequest('slack', 'slack', { url: text, token: TOKEN }, 'slack', { method: 'POST', body: {} }))).code).toBe('slack.response-json');
});
