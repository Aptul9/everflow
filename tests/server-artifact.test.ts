import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { startServer } from '../src/server.ts';
import { SCRATCH } from './support.ts';

test('manual server requires an explicit build receipt before reading instance configuration', async () => {
  const root = mkdtempSync(join(SCRATCH, 'server-build-context-'));
  await expect(startServer({ configPath: join(root, 'absent-synthetic.toml') } as Parameters<typeof startServer>[0])).rejects.toThrow(/explicit.*build receipt/i);
});
