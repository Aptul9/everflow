import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from './build.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';

// The README test gate as one command: both typechecks and Vitest inside a completed stage, Git metadata from this checkout.
// node scripts/gate.ts <absolute build-receipt.json> [vitest arguments]
const [receipt, ...vitest] = process.argv.slice(2);
const artifact = readBuildReceipt(receipt);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = spawnSync('git', ['-C', source, 'ls-files', '-z', '--', '*.py', 'requirements.txt'], { encoding: 'utf8' });
if (index.error || index.status !== 0) throw new Error(`Git index inventory failed (${index.status})`);
const env = { ...isolatedEnvironment(artifact.root, process.env), NODE_ENV: 'test' as const, TEST_BUILD_RECEIPT: receipt!, EVERFLOW_ARTIFACT: receipt!,
  TEST_TRACKED_LEGACY_PATHS: JSON.stringify(index.stdout.split('\0').filter(Boolean)) };
for (const args of [
  ['node_modules/typescript/bin/tsc', '--noEmit'],
  ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.server.json'],
  ['node_modules/vitest/vitest.mjs', 'run', ...vitest],
]) {
  const result = spawnSync(process.execPath, args, { cwd: artifact.root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
