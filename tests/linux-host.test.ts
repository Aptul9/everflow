import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/core/config.ts';
import { acquireInstance } from '../src/core/daemon.ts';
import * as transport from '../src/core/opencode.ts';
import { allowedHost, guardPost } from '../src/web/api.ts';
import type { WebInstance } from '../src/web/instance.ts';
import { sshRun } from '../src/watchers/relay.ts';
import { createKernel } from '../src/windows/kernel.ts';
import { scriptedPeer } from './opencode-support.ts';
import { scratch } from './support.ts';

const linux = process.platform === 'linux';
afterEach(() => vi.unstubAllEnvs());

function sleeper() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

test.skipIf(!linux)('posix kernel reads /proc identity, follows the exact process and terminates only it', async () => {
  using kernel = createKernel();
  const self = kernel.processIdentity(process.pid);
  expect(self).toEqual({ pid: process.pid, created: expect.stringMatching(/^\d+$/), image: process.execPath });
  const child = sleeper();
  await once(child, 'spawn');
  const identity = kernel.processIdentity(child.pid!);
  expect(kernel.running(identity)).toBe(true);
  expect(kernel.childOf(identity, self)).toBe(true);
  expect(kernel.running({ ...identity, created: String(BigInt(identity.created) + 1n) })).toBe(false);
  expect(kernel.terminate({ ...identity, image: '/usr/bin/not-this-image' })).toBe(false);
  expect(kernel.wait(identity, 50)).toBe(false);
  expect(kernel.terminate(identity)).toBe(true);
  // killed but not reaped yet: a zombie reads as exited
  expect(kernel.running(identity)).toBe(false);
  expect(kernel.wait(identity, 0)).toBe(true);
  expect(kernel.terminate(identity)).toBe(false);
  expect(() => kernel.terminate(self)).toThrow(/native.self-termination/);
  expect(kernel.inJob()).toBe(false);
});

test.skipIf(!linux)('posix kernel captures a child that exited before its identity was read', async () => {
  using kernel = createKernel();
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'spawn');
  // block the event loop so libuv cannot reap the child before the read
  const until = Date.now() + 500;
  while (Date.now() < until) { /* wait for exit */ }
  const identity = kernel.processIdentity(child.pid!);
  expect(identity.image).toBe(`/proc/${child.pid}/exe`);
  expect(kernel.running(identity)).toBe(false);
  await once(child, 'exit');
});

test.skipIf(!linux)('posix launch detaches and reports the identity of the new process', () => {
  using kernel = createKernel();
  const identity = kernel.launchIdentity({ executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], cwd: '/', environment: { PATH: '/usr/bin:/bin' } });
  try {
    expect(identity.image).toBe(process.execPath);
    expect(kernel.running(identity)).toBe(true);
  } finally { expect(kernel.terminate(identity)).toBe(true); }
});

test.skipIf(!linux)('instance lock is an abstract socket held once per database and released on close', async () => {
  const { path } = scratch('linux-lock-');
  const first = await acquireInstance(path);
  expect(first.pipe.startsWith('\0everflow-')).toBe(true);
  await expect(acquireInstance(path)).rejects.toMatchObject({ code: 'daemon.already-running' });
  await first.close();
  const again = await acquireInstance(path);
  await again.close();
});

test.skipIf(!linux)('host "local" runs the source command in a local bash instead of ssh', async () => {
  const output = await sshRun('oemail', 'oemail', { host: 'local' }, 'printf "%s" "$((6 * 7))"');
  expect(output.toString()).toBe('42');
  await expect(sshRun('oemail', 'oemail', { host: 'local' }, 'exit 3')).rejects.toMatchObject({ code: 'oemail.ssh-failed' });
});

test('public origin admits its HTTPS host and Origin next to the loopback ones, nothing else', () => {
  const origin = 'https://everflow.example.invalid';
  expect(allowedHost('127.0.0.1:8789', 8789, origin)).toBe(true);
  expect(allowedHost('everflow.example.invalid', 8789, origin)).toBe(true);
  expect(allowedHost('Everflow.Example.Invalid', 8789, origin)).toBe(true);
  expect(allowedHost('everflow.example.invalid', 8789)).toBe(false);
  expect(allowedHost('other.example.invalid', 8789, origin)).toBe(false);
  const current = { port: 8789, token: 'a'.repeat(64), config: { web: { port: 8789, public_origin: origin } } } as unknown as WebInstance;
  const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
  expect(() => guardPost(headers({ host: 'everflow.example.invalid', origin, 'x-everflow-token': current.token }), current)).not.toThrow();
  expect(() => guardPost(headers({ host: '127.0.0.1:8789', origin: 'http://127.0.0.1:8789', 'x-everflow-token': current.token }), current)).not.toThrow();
  expect(() => guardPost(headers({ host: 'everflow.example.invalid', origin: 'http://everflow.example.invalid', 'x-everflow-token': current.token }), current)).toThrow(/Origin rejected/);
  expect(() => guardPost(headers({ host: 'everflow.example.invalid', origin: 'https://evil.example.invalid', 'x-everflow-token': current.token }), current)).toThrow(/Origin rejected/);
  expect(() => guardPost(headers({ host: 'everflow.example.invalid', origin, 'x-everflow-token': 'b'.repeat(64) }), current)).toThrow(/Origin rejected/);
});

test('config accepts only an https scheme and host as public_origin', () => {
  const { config, root } = scratch('linux-origin-');
  const load = (value: string) => {
    const path = `${root}/origin-${Math.random().toString(36).slice(2)}.toml`;
    writeFileSync(path, `[db]\npath = "fixture.db"\n[web]\npublic_origin = ${JSON.stringify(value)}\n`);
    return loadConfig(path);
  };
  expect(load('https://Everflow.Example.Invalid').web.public_origin).toBe('https://everflow.example.invalid');
  for (const bad of ['http://everflow.example.invalid', 'https://everflow.example.invalid/', 'https://everflow.example.invalid/path', 'everflow.example.invalid']) {
    expect(() => load(bad)).toThrow();
  }
  expect(loadConfig(config).web.public_origin).toBeUndefined();
});

test('openchamber_port signs in to an OpenChamber web server with OPENCHAMBER_UI_PASSWORD', async () => {
  await using peer = await scriptedPeer();
  const files = scratch('linux-openchamber-');
  const cfg = loadConfig(files.config);
  cfg.opencode.url = '';
  cfg.opencode.openchamber_port = Number(new URL(peer.url).port);
  vi.stubEnv('OPENCHAMBER_UI_PASSWORD', 'synthetic-ui-secret');
  peer.state.hook = (call, response) => {
    if (call.url.pathname === '/auth/session') {
      expect(call.body).toEqual({ password: 'synthetic-ui-secret' });
      response.writeHead(200, { 'set-cookie': 'oc_session=synthetic-cookie; Path=/' }); response.end('{}'); return true;
    }
    if (call.cookie !== 'oc_session=synthetic-cookie') { peer.json(response, {}, 401); return true; }
    return false;
  };
  const api = transport.connect(cfg, { readSettings: () => { throw new Error('desktop settings must not be read'); } });
  await api.create('Synthetic', 'store', 1);
  expect(peer.calls.map((call) => call.url.pathname)).toEqual(['/auth/session', '/api/session']);
});
