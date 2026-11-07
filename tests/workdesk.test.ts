import fs from 'node:fs';
import { expect, test } from 'vitest';
import { HELP } from '../src/cli.ts';

test('Workdesk identity retains legacy launcher compatibility', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  expect(pkg.name).toBe('workdesk');
  expect(pkg.scripts.workdesk).toBe(pkg.scripts.inbox);
  expect(HELP).toContain('Workdesk');
  expect(HELP).toContain('npm run workdesk');
  expect(HELP).toContain('INBOX_DISPATCHER_ARTIFACT');
});
