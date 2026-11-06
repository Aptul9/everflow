import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextServer, NextServerOptions, RequestHandler } from 'next/dist/server/next.js';
import { loadConfig } from './dispatcher/config.ts';
import { allowedHost, errorResponse, guardPost } from './web/api.ts';
import { initialize, release } from './web/instance.ts';
import type { WebInstance } from './web/instance.ts';
import { readBuildReceipt, samePath } from './web/build-artifact.ts';

export async function startServer(options: { configPath: string; buildReceipt: string; port?: number }) {
  const artifact = readBuildReceipt(options?.buildReceipt);
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (!samePath(moduleRoot, artifact.root) || !samePath(process.cwd(), artifact.root)) throw new Error('Launch the compiled staged server with its staged working directory');
  if (!options || typeof options.configPath !== 'string' || !isAbsolute(options.configPath)) throw new Error('Absolute explicit instance config required');
  process.env.INBOX_DISPATCHER_BUILD_ROOT = artifact.root;
  const next = createRequire(import.meta.url)('next') as (options: NextServerOptions) => Pick<NextServer, 'prepare' | 'close' | 'getRequestHandler'>;
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
  let app: Pick<NextServer, 'prepare' | 'close' | 'getRequestHandler'> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    handle = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    try { await app?.close(); } finally { if (current) release(current); }
  })();
  try {
    current = { config, configPath: config._config_path, port, token: randomBytes(32).toString('hex') };
    initialize(current);
    app = next({ dev: false, dir: artifact.root, hostname: '127.0.0.1', port, httpServer: server });
    await app.prepare();
    handle = app.getRequestHandler();
    return { port, close };
  } catch (error) { await close(); throw error; }
}
