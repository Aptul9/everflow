import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SCRATCH } from './support.ts';
import { actionHeaders, http, launch, rootToken } from './web-support.ts';

test('explicit scratch showcase launches a built page with every group and closes its owned listener', async () => {
  const root = join(mkdtempSync(join(SCRATCH, 'phase6-showcase-check-')), 'instance');
  const server = await launch('web-showcase.ts', ['--root', root]);
  try {
    const response = await http(server.port, '/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Review synthetic access');
    const state = JSON.parse((await http(server.port, '/api/state')).text);
    for (const group of Object.values(state.groups) as unknown[][]) expect(group.length).toBeGreaterThan(0);
    expect(state.skipped).toHaveLength(3);
    const dismissed = await http(server.port, '/api/ticket/2/dismiss', {
      method: 'POST', headers: actionHeaders(server.port, rootToken(response.text)), body: '{"reason":"Synthetic showcase check"}',
    });
    expect(dismissed.status).toBe(200);
    expect(JSON.parse((await http(server.port, '/api/state')).text).feedback.dismiss_count).toBe(1);
  } finally { await server.close(); }
  await expect(http(server.port, '/')).rejects.toThrow();
});
