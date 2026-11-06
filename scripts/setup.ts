import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function nativeBuildEnv<T extends Record<string, string | undefined>>(base: T) {
  return {
    ...base,
    npm_package_config_node_gyp_enable_thin_lto: 'false',
    npm_package_config_node_gyp_enable_lto: 'false',
    npm_package_config_node_gyp_lto_jobs: '',
  };
}

export function verifyNativeConfig(text: string): void {
  const { variables } = JSON.parse(text.replace(/^#.*$/gm, '')) as { variables: Record<string, unknown> };
  for (const [key, value] of Object.entries({ clang: 0, enable_lto: 'false', enable_thin_lto: 'false', lto_jobs: '' })) {
    assert.equal(variables[key], value, `winax config: ${key}`);
  }
}

if (import.meta.main) {
  assert.equal(process.versions.node, '26.4.0', 'Use the pinned Node version');
  const { values } = parseArgs({ options: { log: { type: 'string' }, 'verify-only': { type: 'boolean' } } });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const started = new Date().toISOString();
  let status = 0;
  if (!values['verify-only']) {
    if (values.log) mkdirSync(dirname(resolve(values.log)), { recursive: true });
    const fd = values.log ? openSync(values.log, 'a') : undefined;
    try {
      const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
      const result = spawnSync(process.execPath, [npm, 'ci', '--foreground-scripts', '--no-audit', '--no-fund'], {
        cwd: root, env: nativeBuildEnv(process.env), windowsHide: true,
        stdio: fd === undefined ? 'inherit' : ['ignore', fd, fd], timeout: 600_000,
      });
      if (result.error) throw result.error;
      status = result.status ?? 1;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  if (status !== 0) process.exit(status);
  const configPath = join(root, 'node_modules/winax/build/config.gypi');
  const config = readFileSync(configPath, 'utf8');
  verifyNativeConfig(config);
  const require = createRequire(import.meta.url);
  const koffi = require('koffi') as { version: string; load: unknown };
  const winax = require('winax') as { Object: unknown };
  const winaxVersion = (require('winax/package.json') as { version: string }).version;
  assert.equal(koffi.version, '3.3.7');
  assert.equal(typeof koffi.load, 'function');
  assert.equal(typeof winax.Object, 'function');
  assert.equal(winaxVersion, '3.6.10');
  const report = {
    started, ended: new Date().toISOString(), node: process.version, status,
    overrides: nativeBuildEnv({}), configPath,
    generated: { clang: 0, enable_lto: 'false', enable_thin_lto: 'false', lto_jobs: '' },
    loaded: { koffi: koffi.version, winax: winaxVersion },
  };
  if (values.log) appendFileSync(values.log, '\n' + JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
