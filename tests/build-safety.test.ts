import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

function manifests(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? manifests(join(root, entry.name)) : entry.name.endsWith('.nft.json') ? [join(root, entry.name)] : []);
}

test('production traces exclude held data/config and remote model/session runtime', () => {
  expect(existsSync('.next/BUILD_ID'), 'Run npm run build before the production artifact checks').toBe(true);
  const files = manifests('.next/server');
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const trace = JSON.parse(readFileSync(file, 'utf8')) as { files: string[] };
    const unsafe = trace.files.filter((path) => /(?:^|\/)data\/|(?:^|\/)config\.toml$|(?:^|\/)\.venv\/|src\/dispatcher\/(?:opencode|kb-agent)\./.test(path));
    expect(unsafe, `Unsafe dependency trace: ${file}`).toEqual([]);
  }
});

test('HTTP approval imports a shared local transaction, never the remote chat worker', () => {
  const source = readFileSync('src/web/api.ts', 'utf8');
  expect(source).not.toMatch(/from ['"][^'"]*dispatcher\/chat/);
});
