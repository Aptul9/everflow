import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import { isolatedEnvironment } from '../scripts/build.ts';

export async function serve(config: string) {
  return launch('web-process.ts', [], { TEST_INSTANCE_CONFIG: config });
}

export async function launch(script: string, args: string[], env: Record<string, string | undefined> = {}) {
  const receipt = env.TEST_BUILD_RECEIPT ?? process.env.TEST_BUILD_RECEIPT;
  const artifact = readBuildReceipt(receipt);
  const child = fork(fileURLToPath(new URL(script, import.meta.url)), args, {
    cwd: artifact.root,
    env: { ...isolatedEnvironment(artifact.root, process.env), ...env, TEST_BUILD_RECEIPT: receipt!, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [], windowsHide: true,
  });
  let log = '';
  child.stdout!.on('data', (data: Buffer) => { log += data.toString(); });
  child.stderr!.on('data', (data: Buffer) => { log += data.toString(); });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`HTTP startup timeout: ${log}`)); }, 60_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`HTTP child exited ${code}: ${log}`)); });
    child.once('message', (message: unknown) => {
      clearTimeout(timer);
      const ready = message as { ready: boolean; port: number };
      if (!ready.ready || !Number.isInteger(ready.port)) reject(new Error(`Unexpected HTTP startup: ${log}`));
      else resolve(ready.port);
    });
  });
  return { port, child, log: () => log, close: () => stop(child) };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned HTTP server did not shut down')); }, 15_000);
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`HTTP shutdown exited ${code}`)); });
    child.send({ stop: true });
  });
}

export async function http(port: number, path: string, options: { method?: string; body?: string; headers?: Record<string, string | string[]>; noHost?: boolean } = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const headers = { ...(options.noHost ? {} : { host: `127.0.0.1:${port}` }), ...options.headers };
    const rawHeaders = Object.entries(headers).flatMap(([name, values]) => (Array.isArray(values) ? values : [values]).flatMap((value) => [name, value]));
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', setHost: !options.noHost,
      headers: rawHeaders }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (part: string) => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.once('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('HTTP request deadline')));
    req.end(options.body);
  });
}

export function rootToken(text: string): string {
  const token = /<meta name="dispatcher-token" content="([^"]+)"/.exec(text)?.[1];
  if (!token) throw new Error('Dynamic root has no current action token');
  return token;
}

export function actionHeaders(port: number, token: string) {
  return { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'x-dispatcher-token': token };
}
