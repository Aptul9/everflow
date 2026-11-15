import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { isolatedEnvironment } from '../scripts/build.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';

test('compiled source modules import without opening sources, models, caches or default everflow configuration', () => {
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const paths = ['outlook', 'teams', 'relay', 'gchat', 'gmail'].map((name) => pathToFileURL(join(artifact.root, 'dist/watchers', name + '.js')).href);
  const script = `for (const url of ${JSON.stringify(paths)}) await import(url); console.log(JSON.stringify({imported:5}));`;
  const result = spawnSync(process.execPath, ['--use-system-ca', '--input-type=module', '-e', script], {
    cwd: artifact.root, env: { ...isolatedEnvironment(artifact.root, process.env), NODE_ENV: 'test' }, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ imported: 5 }); expect(result.stderr).toBe('');
});

test.each(['outlook', 'teams', 'relay', 'gchat', 'gmail'])('compiled %s entrypoint handles path spaces and fails missing --since before any source access', (name) => {
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const directory = fs.mkdtempSync(join(artifact.root, '.private', 'source command fixture '));
  for (const part of ['watchers', 'windows', 'posix']) fs.cpSync(join(artifact.root, 'dist', part), join(directory, part), { recursive: true });
  fs.mkdirSync(join(directory, 'core'));
  fs.copyFileSync(join(artifact.root, 'dist/core/time.js'), join(directory, 'core/time.js'));
  const result = spawnSync(process.execPath, ['--use-system-ca', join(directory, 'watchers', name + '.js')], {
    cwd: artifact.root, env: { ...isolatedEnvironment(artifact.root, process.env), NODE_ENV: 'test' }, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toEqual({ source: name === 'relay' ? 'teamsrelay' : name, code: 'source.since-required' });
});
