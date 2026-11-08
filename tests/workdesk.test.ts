import fs from 'node:fs';
import { expect, test } from 'vitest';
import { HELP } from '../src/cli.ts';

test('Workdesk identity has one launcher and no legacy alias', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  expect(pkg.name).toBe('workdesk');
  expect(pkg.scripts.workdesk).toBe('node src/cli.ts');
  expect(pkg.scripts.inbox).toBeUndefined();
  expect(HELP).toContain('Workdesk');
  expect(HELP).toContain('npm run workdesk');
  expect(HELP).toContain('WORKDESK_ARTIFACT');
  expect(HELP).not.toMatch(/inbox/i);
});
