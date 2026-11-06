import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import type { NextServer, NextServerOptions, RequestHandler } from 'next/dist/server/next.js';
import { loadConfig } from './dispatcher/config.ts';
import { allowedHost, errorResponse, guardPost } from './web/api.ts';
import { initialize, release } from './web/instance.ts';
import type { WebInstance } from './web/instance.ts';

const next = createRequire(import.meta.url)('next') as (options: NextServerOptions) => Pick<NextServer, 'prepare' | 'close' | 'getRequestHandler'>;

export async function startServer(options: { configPath: string; port?: number }) {
  if (!options || typeof options.configPath !== 'string' || !isAbsolute(options.configPath)) throw new Error('Absolute explicit instance config required');
  const config = loadConfig(options.configPath);
  const requestedPort = options.port ?? config.web.port;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid web port');
  let handle: RequestHandler | undefined;
  let current: WebInstance | undefined;
  const server = createServer({ requireHostHeader: false }, (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    const hosts = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === 'host').length;
    if (!current || hosts !== 1 || !allowedHost(request.headers.host, current.port)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Local Host required');
      return;
    }
    if (request.method === 'POST') {
      try { guardPost({ get: (name) => typeof request.headers[name] === 'string' ? request.headers[name] : null }, current); }
      catch (error) {
        const failure = errorResponse(error);
        response.writeHead(failure.status, Object.fromEntries(failure.headers));
        void failure.text().then((text) => response.end(text));
        return;
      }
    }
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) { response.writeHead(400).end('Relative request target required'); return; }
    if (!handle) { response.writeHead(503).end('Local instance preparing'); return; }
    delete request.headers['x-forwarded-host'];
    delete request.headers['x-forwarded-port'];
    delete request.headers['x-forwarded-proto'];
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(503);
      response.end('Local instance unavailable');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  const app = next({ dev: false, hostname: '127.0.0.1', port, httpServer: server });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    handle = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await app.close();
    if (current) release(current);
  })();
  try {
    current = { config, configPath: config._config_path, port, token: randomBytes(32).toString('hex') };
    initialize(current);
    await app.prepare();
    handle = app.getRequestHandler();
    return { port, close };
  } catch (error) { await close(); throw error; }
}
