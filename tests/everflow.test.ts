import fs from 'node:fs';
import { expect, test } from 'vitest';
import { HELP } from '../src/cli.ts';

test('Everflow identity has one launcher and no legacy alias', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  expect(pkg.name).toBe('everflow');
  expect(pkg.scripts.everflow).toBe('node src/cli.ts');
  expect(pkg.scripts.inbox).toBeUndefined();
  expect(HELP).toContain('Everflow');
  expect(HELP).toContain('npm run everflow');
  expect(HELP).toContain('EVERFLOW_ARTIFACT');
  expect(HELP).not.toMatch(/inbox/i);
});
