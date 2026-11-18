import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { NextServer, NextServerOptions, RequestHandler } from 'next/dist/server/next.js';
import { loadConfig } from './core/config.ts';
import { allowedHost, errorResponse, guardPost } from './web/api.ts';
import { initialize, release } from './web/instance.ts';
import type { WebInstance } from './web/instance.ts';
import { readBuildReceipt, samePath } from './web/build-artifact.ts';
import { acquireInstance, atomicJson, cleanupChildren, DaemonError, instancePaths, readDaemonReceipt, readJson } from './core/daemon.ts';
import type { DaemonReceipt } from './core/daemon.ts';
import { migrate, openDb, prepareStart } from './core/db.ts';
import { startRuntime, validateRuntimeConfig } from './core/runtime.ts';
import { createKernel } from './windows/kernel.ts';
import { Limiter, loginAccount, loginKey, Sessions, verifyPassword } from './web/login.ts';
import { signIn } from './web/login-http.ts';
import { ChatToken, chatGate, GATE_PATH } from './web/chat-gate.ts';
import { ChatFiles } from './web/chat-files.ts';

export async function startServer(options: { configPath: string; buildReceipt: string; port?: number }) {
  const artifact = readBuildReceipt(options?.buildReceipt);
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (!samePath(moduleRoot, artifact.root) || !samePath(process.cwd(), artifact.root)) throw new Error('Launch the compiled staged server with its staged working directory');
  if (!options || typeof options.configPath !== 'string' || !isAbsolute(options.configPath)) throw new Error('Absolute explicit instance config required');
  process.env.EVERFLOW_BUILD_ROOT = artifact.root;
  const next = createRequire(import.meta.url)('next') as (options: NextServerOptions) => Pick<NextServer, 'prepare' | 'close' | 'getRequestHandler'>;
  const config = loadConfig(options.configPath);
  // Fails closed: a public origin without an account refuses to start rather than serve the page openly
  const login = config.web.public_origin ? (() => {
    const account = loginAccount();
    return { sessions: new Sessions(loginKey(config.db.path), account), limiter: new Limiter(),
      // the hash is always checked, so a wrong user costs the same time as a wrong password
      check: (user: string, password: string) => verifyPassword(password, account.hash) && user.toLowerCase() === account.user.toLowerCase() };
  })() : undefined;
  // The chat host's gate: OpenChamber is the loopback web server of [opencode] openchamber_port, which config.ts requires with chat_origin
  const chat = login && config.web.chat_origin && config.opencode.openchamber_port
    ? new ChatToken(config.db.path + '.chat-token', `http://127.0.0.1:${config.opencode.openchamber_port}`, () => process.env.OPENCHAMBER_UI_PASSWORD ?? '')
    : undefined;
  const requestedPort = options.port ?? config.web.port;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid web port');
  let handle: RequestHandler | undefined;
  let current: WebInstance | undefined;
  const server = createServer({ requireHostHeader: false }, (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    const hosts = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === 'host').length;
    if (!current || hosts !== 1 || !allowedHost(request.headers.host, current.port, current.config.web.public_origin)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Local Host required');
      return;
    }
    // Loopback only: under the public host the token would reach a browser
    if (new URL(request.url ?? '/', 'http://everflow.invalid').pathname === GATE_PATH) {
      if (`https://${request.headers.host?.toLowerCase()}` === current.config.web.public_origin) response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      else chatGate(request, response, current);
      return;
    }
    // The public host needs a session; loopback stays as before (the daemon only listens there)
    if (current.login && `https://${request.headers.host?.toLowerCase()}` === current.config.web.public_origin
      && signIn(request, response, current, current.login)) return;
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
    current = { config, configPath: config._config_path, port, token: randomBytes(32).toString('hex'), ...(login ? { login } : {}), ...(chat ? { chat, files: new ChatFiles(chat) } : {}) };
    initialize(current);
    app = next({ dev: false, dir: artifact.root, hostname: '127.0.0.1', port, httpServer: server });
    await app.prepare();
    handle = app.getRequestHandler();
    return { port, close };
  } catch (error) { await close(); throw error; }
}

export async function startDaemon(options: { configPath: string; buildReceipt: string; runId: string; port?: number }) {
  const artifact = readBuildReceipt(options.buildReceipt);
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (!samePath(moduleRoot, artifact.root) || !samePath(process.cwd(), artifact.root)) throw new DaemonError('daemon.staged-server-required');
  const cfg = loadConfig(options.configPath);
  validateRuntimeConfig(cfg, options.buildReceipt);
  const paths = instancePaths(cfg.db.path, options.runId);
  cfg.db.path = paths.db;
  const owner = await acquireInstance(paths.db);
  let kernel: ReturnType<typeof createKernel>;
  let identity: ReturnType<ReturnType<typeof createKernel>['processIdentity']>;
  try { kernel = createKernel(); identity = kernel.processIdentity(process.pid); }
  catch (error) { await owner.close(); throw error; }
  let db: ReturnType<typeof openDb> | undefined, web: Awaited<ReturnType<typeof startServer>> | undefined;
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined, watcher: fs.FSWatcher | undefined, closing: Promise<void> | undefined;
  const terminal = Promise.withResolvers<void>();
  const stamp = new Date().toISOString();
  const receipt: DaemonReceipt = { ...identity, version: 1, status: 'starting', run_id: options.runId,
    config_path: cfg._config_path, db_path: paths.db, artifact: options.buildReceipt, port: 0,
    started_at: stamp, heartbeat_at: stamp, argv: process.argv, children: [] };
  let published = false, starting = true, startupFailed = false, startupFailure: unknown;
  const save = () => { atomicJson(paths.receipt, receipt); published = true; };
  const close = () => closing ??= (async () => {
    watcher?.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await runtime?.close(); await web?.close();
    if (db) {
      db.prepare("UPDATE health SET state='stopped' WHERE dependency='daemon'").run();
      db.close(); db = undefined;
    }
    if (published) { receipt.status = 'stopped'; receipt.heartbeat_at = new Date().toISOString(); save(); }
    await owner.close(); kernel[Symbol.dispose](); terminal.resolve();
  })();
  // A failed close retains the writer pipe. The manual caller's exact-identity fallback ends this process.
  const stop = () => { void close().catch(() => { process.exitCode = 1; }); };
  const requested = () => {
    try {
      const value = readJson(paths.stop) as Partial<DaemonReceipt> | null;
      if (value?.run_id === receipt.run_id && value.pid === receipt.pid && value.created === receipt.created) stop();
    } catch { /* Malformed or foreign stop requests cannot control this run. */ }
  };
  try {
    const previous = readDaemonReceipt(cfg);
    if (previous) {
      if (!kernel.wait(previous, 1000)) throw new DaemonError('daemon.previous-identity-running');
      cleanupChildren(previous.children, kernel);
    }
    fs.mkdirSync(dirname(paths.db), { recursive: true });
    save();
    await migrate(paths.db);
    db = openDb(paths.db);
    prepareStart(db, cfg.start.triage_after);
    web = await startServer({ configPath: cfg._config_path, buildReceipt: options.buildReceipt, ...(options.port === undefined ? {} : { port: options.port }) });
    receipt.port = web.port;
    watcher = fs.watch(dirname(paths.stop), (_event, name) => { if (String(name) === basename(paths.stop)) requested(); });
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    runtime = await startRuntime(cfg, db, { buildReceipt: options.buildReceipt, runId: receipt.run_id, restartAt: stamp,
      metadata: { pid: receipt.pid, created: receipt.created, config_path: receipt.config_path, port: receipt.port, artifact: receipt.artifact },
      onChildren: (children) => { receipt.children = children; save(); },
      onHeartbeat: () => { receipt.heartbeat_at = new Date().toISOString(); save(); },
      onError: (error) => { if (starting) { startupFailed = true; startupFailure = error; } else stop(); },
      titles: cfg.tickets.enabled === true && cfg.chats.enabled === true });
    if (startupFailed) throw startupFailure;
    starting = false;
    receipt.status = 'ready'; save(); atomicJson(paths.ready, receipt); requested();
    return { receipt, close, done: terminal.promise };
  } catch (error) { await close(); throw error; }
}
