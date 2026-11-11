import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { webFixture } from './web-fixture.ts';
import { actionHeaders, http, rootToken, serve } from './web-support.ts';

const fixture = webFixture();
let server: Awaited<ReturnType<typeof serve>>;
let token: string;
beforeAll(async () => { server = await serve(fixture.config); }, 90_000);
afterAll(async () => { await server?.close(); });

test('serves the dynamic Next root, compiled assets, state and newest-first detail', async () => {
  const root = await http(server.port, '/');
  expect(root.status).toBe(200);
  expect(root.headers['content-type']).toContain('text/html');
  expect(root.text).toContain('Everflow');
  expect(root.text).toContain('Review synthetic access');
  expect(root.text).not.toContain('<script>untrusted()</script>');
  token = rootToken(root.text);
  const asset = /(?:src|href)="([^\"]*\/_next\/static\/[^\"]+)"/.exec(root.text)?.[1];
  expect(asset).toBeTruthy();
  expect((await http(server.port, asset!)).status).toBe(200);
  const state = await http(server.port, '/api/state');
  expect(state.status).toBe(200);
  expect(state.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
  expect(state.headers['access-control-allow-origin']).toBeUndefined();
  expect(state.text).not.toContain(token);
  expect(state.text).not.toContain('DO-NOT-SERIALIZE');
  expect(state.text).not.toContain('HEALTH-SECRET');
  const dto = JSON.parse(state.text);
  expect(dto.groups.needs_you[0].lifecycle).toBe('proposed');
  expect(dto.groups.working.some((ticket: { stage: string }) => ticket.stage === 'Idle')).toBe(true);
  expect(dto.groups.waiting_them.map((ticket: { id: number }) => ticket.id)).toContain(fixture.waiting);
  expect(dto.groups.failed.map((ticket: { id: number }) => ticket.id)).toContain(fixture.failed);
  expect(dto.groups.done_today.map((ticket: { id: number }) => ticket.id)).toContain(fixture.done);
  expect(dto.groups.done_today.map((ticket: { id: number }) => ticket.id)).not.toContain(fixture.dismissed);
  expect(dto.groups.skipped.map((ticket: { id: number }) => ticket.id)).toContain(fixture.dismissed);
  expect(dto.groups.done_today.some((ticket: { title: string }) => ticket.title === 'Old terminal work')).toBe(false);
  expect(dto.skipped.map((batch: { outcome: string }) => batch.outcome)).toEqual(expect.arrayContaining(['not_on_us', 'backlog', 'answered']));
  expect(dto.health.map((health: { dependency: string }) => health.dependency)).toEqual(expect.arrayContaining(['daemon', 'outlook', 'teams', 'provider:synthetic', 'opencode']));
  expect(dto.health.some((health: { scope: string }) => health.scope === 'account')).toBe(true);
  expect(dto.problems.jobs.some((job: { id: number; ticket: number | null }) => job.id === fixture.unbound && job.ticket === null)).toBe(true);
  expect(dto.problems.quarantine[0].line).toBe('<quarantined>');
  expect(dto.problems.triage[0]).toMatchObject({ raw: '<bad-model-output>', parse_error: 'Expected JSON object' });
  const detail = await http(server.port, `/api/ticket/${fixture.proposal}`);
  expect(detail.status).toBe(200);
  const body = JSON.parse(detail.text);
  expect(body.messages[0].text).toBe('<script>untrusted()</script> literal source');
  expect(body.timeline.map((event: { id: number }) => event.id)).toEqual([...body.timeline].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id).map((event) => event.id));
  expect(detail.text).not.toContain(token);
});

test('canonical state revalidates with 304, no body, and changes only on persisted input', async () => {
  const first = await http(server.port, '/api/state');
  expect(first.status).toBe(200);
  const second = await http(server.port, '/api/state', { headers: { 'if-none-match': first.headers.etag! } });
  expect(second.status).toBe(304);
  expect(second.text).toBe('');
  expect((await http(server.port, '/api/state')).text).toBe(first.text);
  using db = new DatabaseSync(fixture.path);
  db.prepare('UPDATE ticket SET title=? WHERE id=?').run('Updated at runtime', fixture.active);
  const changed = await http(server.port, '/api/state', { headers: { 'if-none-match': first.headers.etag! } });
  expect(changed.status).toBe(200);
  expect(changed.headers.etag).not.toBe(first.headers.etag);
  expect((await http(server.port, '/')).text).toContain('Updated at runtime');
});

test.each(['/', '/api/state', '/not-a-route', '/_next/static/not-real.js'])('rejects hostile Host before routing %s', async (path) => {
  for (const host of [`evil.invalid:${server.port}`, 'localhost', `localhost:${server.port + 1}`, `127.0.0.1:${server.port}.evil.invalid`, `LOCALHOST:${server.port}`]) {
    const response = await http(server.port, path, { headers: { host } });
    expect(response.status).toBe(403);
    expect(response.text).not.toContain('Everflow');
  }
  expect((await http(server.port, path, { noHost: true })).status).toBe(403);
  expect((await http(server.port, path, { headers: { host: [`127.0.0.1:${server.port}`, `localhost:${server.port}`] } })).status).toBe(403);
});

test('accepts exact localhost Host without trusting forwarded headers', async () => {
  expect((await http(server.port, '/api/state', { headers: { host: `localhost:${server.port}`, 'x-forwarded-host': 'evil.invalid' } })).status).toBe(200);
});

test.each(['start', 'chat', 'discuss', 'dismiss'])('guards ticket %s with current token and exact Origin', async (action) => {
  token = rootToken((await http(server.port, '/')).text);
  const headers = actionHeaders(server.port, token);
  const path = `/api/ticket/${fixture.proposal}/${action}`;
  for (const bad of [ { ...headers, 'x-everflow-token': '' }, { ...headers, 'x-everflow-token': 'wrong' },
    { ...headers, 'x-everflow-token': 'é'.repeat(token.length) }, { ...headers, origin: '' },
    { ...headers, origin: 'null' }, { ...headers, origin: `https://127.0.0.1:${server.port}` },
    { ...headers, origin: `http://localhost:${server.port}` }, { ...headers, origin: `http://127.0.0.1:${server.port}/` } ]) {
    expect((await http(server.port, path, { method: 'POST', headers: bad, body: '{}' })).status).toBe(403);
  }
  using db = new DatabaseSync(fixture.path, { readOnly: true });
  expect(db.prepare('SELECT approved_at FROM ticket WHERE id=?').get(fixture.proposal)!.approved_at).toBeNull();
});

test('guards every POST, including batch/job actions and unknown paths/assets', async () => {
  for (const path of [`/api/batch/${fixture.skipped}/ticket`, `/api/job/${fixture.failedJob}/retry`, '/unknown', '/_next/static/missing.js']) {
    expect((await http(server.port, path, { method: 'POST', body: '{}' })).status).toBe(403);
  }
});

test.each(['batch', 'job'])('validates %s action guards, JSON and ids through real routes', async (scope) => {
  const headers = actionHeaders(server.port, rootToken((await http(server.port, '/')).text));
  const id = scope === 'batch' ? fixture.skipped : fixture.failedJob;
  const action = scope === 'batch' ? 'ticket' : 'retry';
  const path = `/api/${scope}/${id}/${action}`;
  for (const bad of [{ ...headers, origin: 'http://evil.invalid' }, { ...headers, 'x-everflow-token': 'stale' }]) {
    const result = await http(server.port, path, { method: 'POST', headers: bad, body: '{}' });
    expect(result.status).toBe(403);
    expect(result.headers['access-control-allow-origin']).toBeUndefined();
  }
  for (const body of ['[]', 'null', '{', '{"extra":true}']) expect((await http(server.port, path, { method: 'POST', headers, body })).status).toBe(400);
  expect((await http(server.port, path, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  expect((await http(server.port, path, { method: 'POST', headers: { ...headers, 'transfer-encoding': 'chunked' }, body: ' '.repeat(33_000) })).status).toBe(413);
  for (const invalid of ['0', '-1', '1.5', '9007199254740992', 'bad', '01']) expect((await http(server.port, `/api/${scope}/${invalid}/${action}`, { method: 'POST', headers, body: '{}' })).status).toBe(400);
});

test('validates note/reason string bounds without changing state and accepts matching localhost Origin', async () => {
  const headers = actionHeaders(server.port, rootToken((await http(server.port, '/')).text));
  for (const note of ['', '   ', 'x'.repeat(8_001)]) expect((await http(server.port, `/api/ticket/${fixture.proposal}/chat`, {
    method: 'POST', headers, body: JSON.stringify({ note }),
  })).status).toBe(400);
  expect((await http(server.port, `/api/ticket/${fixture.proposal}/dismiss`, { method: 'POST', headers, body: JSON.stringify({ reason: 'x'.repeat(2_001) }) })).status).toBe(400);
  expect((await http(server.port, `/api/ticket/${fixture.dismissed}/dismiss`, { method: 'POST',
    headers: { ...headers, host: `localhost:${server.port}`, origin: `http://localhost:${server.port}`, 'content-type': 'application/json; charset=utf-8' }, body: '{}',
  })).status).toBe(200);
});

test.each(['start', 'chat', 'discuss', 'dismiss'])('validates %s JSON objects, sizes, media type, ids and allowed fields', async (action) => {
  const headers = actionHeaders(server.port, rootToken((await http(server.port, '/')).text));
  const path = `/api/ticket/${fixture.proposal}/${action}`;
  for (const body of ['{', 'null', '[]', '1', '{"extra":true}', ['chat', 'discuss'].includes(action) ? '{"note":false}' : '{"reason":false}',
    ...action === 'discuss' ? [JSON.stringify({ note: 'x'.repeat(8_001) })] : []]) {
    expect((await http(server.port, path, { method: 'POST', headers, body })).status).toBe(400);
  }
  expect((await http(server.port, path, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  expect((await http(server.port, path, { method: 'POST', headers, body: JSON.stringify({ note: 'x'.repeat(40_000) }) })).status).toBe(413);
  for (const id of ['0', '-1', '1.5', '9007199254740992', 'abc', '01']) {
    expect((await http(server.port, `/api/ticket/${id}/${action}`, { method: 'POST', headers, body: action === 'chat' ? '{"note":"instruction"}' : '{}' })).status).toBe(400);
  }
  expect((await http(server.port, '/api/ticket/999999')).status).toBe(404);
  expect((await http(server.port, `/api/ticket/999999/${action}`, { method: 'POST', headers, body: action === 'chat' ? '{"note":"instruction"}' : '{}' })).status).toBe(404);
});

test('Discuss commits a discussion chat with an optional question, once, without remote calls', async () => {
  const headers = actionHeaders(server.port, rootToken((await http(server.port, '/')).text));
  using db = new DatabaseSync(fixture.path);
  const add = (title: string) => Number(db.prepare(`INSERT INTO ticket(title,summary,ask,proposal,kb_notes,created_at,last_activity_at)
    VALUES (?,'s','a','p','[]','2026-11-06T00:00:00.000000Z','2026-11-06T00:00:00.000000Z')`).run(title).lastInsertRowid);
  const plain = add('Discuss without question');
  const asked = add('Discuss with question');
  const post = (id: number, body: string) => http(server.port, `/api/ticket/${id}/discuss`, { method: 'POST', headers, body });
  expect((await Promise.all([post(plain, '{}'), post(plain, '{}')])).map((response) => response.status)).toEqual([200, 200]);
  expect((await post(asked, JSON.stringify({ note: 'Why UAT first?' }))).status).toBe(200);
  for (const id of [plain, asked]) {
    expect(db.prepare("SELECT payload FROM job WHERE kind='start_chat' AND ticket=?").all(id).map((job) => JSON.parse(String(job.payload)))).toEqual([{ discuss: true }]);
  }
  expect(db.prepare('SELECT lifecycle,approval_note FROM ticket WHERE id=?').get(asked)).toMatchObject({ lifecycle: 'active', approval_note: 'Why UAT first?' });
  expect((await post(asked, '{"note":"different"}')).status).toBe(409);
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()!.n).toBe(0);
});

test('commits double Start once, note approval, dismiss feedback, Make ticket and parked retry without remote calls', async () => {
  const headers = actionHeaders(server.port, rootToken((await http(server.port, '/')).text));
  const post = (path: string, body = '{}') => http(server.port, path, { method: 'POST', headers, body });
  const starts = await Promise.all([post(`/api/ticket/${fixture.proposal}/start`), post(`/api/ticket/${fixture.proposal}/start`)]);
  expect(starts.map((response) => response.status)).toEqual([200, 200]);
  using db = new DatabaseSync(fixture.path);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='start_chat' AND ticket=?").get(fixture.proposal)!.n).toBe(1);
  expect(db.prepare('SELECT COUNT(*) AS n FROM turn').get()!.n).toBe(0);
  const second = Number(db.prepare("SELECT id FROM ticket WHERE title='Second proposal'").get()!.id);
  expect((await post(`/api/ticket/${second}/chat`, JSON.stringify({ note: 'Exact instruction\nSecond line' }))).status).toBe(200);
  expect(db.prepare('SELECT approval_note FROM ticket WHERE id=?').get(second)!.approval_note).toBe('Exact instruction\nSecond line');
  expect((await post(`/api/ticket/${second}/chat`, '{"note":"different"}')).status).toBe(409);
  expect((await post(`/api/ticket/${second}/close`, '{"reason":"Done by hand"}')).status).toBe(200);
  expect(db.prepare('SELECT lifecycle,report_line FROM ticket WHERE id=?').get(second)).toMatchObject({ lifecycle: 'done', report_line: 'Done by hand' });
  expect((await post(`/api/ticket/${second}/close`, '{"reason":"x"}')).status).toBe(200);
  expect((await post(`/api/ticket/${fixture.active}/dismiss`, '{"reason":"Duplicate request"}')).status).toBe(200);
  expect((await post(`/api/ticket/${fixture.active}/close`, '{}')).status).toBe(409);
  for (const batch of [fixture.skipped, fixture.backlog, fixture.answered]) expect((await post(`/api/batch/${batch}/ticket`)).status).toBe(200);
  expect((await post(`/api/batch/${fixture.skipped}/ticket`)).status).toBe(200);
  expect((await post(`/api/job/${fixture.failedJob}/retry`)).status).toBe(200);
  expect((await post(`/api/job/${fixture.failedJob}/retry`)).status).toBe(409);
  expect((await post('/api/job/999999/retry')).status).toBe(404);
  expect((await post('/api/batch/999999/ticket')).status).toBe(404);
  const state = JSON.parse((await http(server.port, '/api/state')).text);
  expect(state.feedback).toMatchObject({ make_ticket_count: 3, dismiss_count: 1 });
  expect(state.feedback.dismiss_reasons[0].reason).toBe('Duplicate request');
});

test.each([{ tickets: false, chats: true }, { tickets: 'true', chats: true }, { tickets: true, chats: false }, { tickets: true, chats: 'true' }])('literal rollout flags fail closed: %j', async (flags) => {
  const off = webFixture(flags);
  const instance = await serve(off.config);
  try {
    const root = await http(instance.port, '/');
    const headers = actionHeaders(instance.port, rootToken(root.text));
    expect(root.text).toContain(flags.tickets === true ? 'Chats off' : 'Tickets disabled');
    for (const action of ['start', 'chat', 'discuss']) expect((await http(instance.port, `/api/ticket/${off.proposal}/${action}`, {
      method: 'POST', headers, body: action === 'chat' ? '{"note":"instruction"}' : '{}',
    })).status).toBe(409);
    if (flags.tickets !== true) {
      for (const path of [`/api/ticket/${off.proposal}/dismiss`, `/api/batch/${off.skipped}/ticket`, `/api/job/${off.failedJob}/retry`]) {
        expect((await http(instance.port, path, { method: 'POST', headers, body: '{}' })).status).toBe(409);
      }
    }
    using db = new DatabaseSync(off.path, { readOnly: true });
    expect(db.prepare('SELECT approved_at FROM ticket WHERE id=?').get(off.proposal)!.approved_at).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind='start_chat'").get()!.n).toBe(0);
  } finally { await instance.close(); }
});

test('restart rotates the root token, rejects stale approval, and shuts down owned listeners', async () => {
  const previous = rootToken((await http(server.port, '/')).text);
  const port = server.port;
  await server.close();
  await expect(http(port, '/api/state')).rejects.toThrow();
  server = await serve(fixture.config);
  const next = rootToken((await http(server.port, '/')).text);
  expect(next).not.toBe(previous);
  expect((await http(server.port, `/api/ticket/${fixture.waiting}/dismiss`, { method: 'POST', headers: actionHeaders(server.port, previous), body: '{}' })).status).toBe(403);
});

test('requires an explicit initialized instance rather than falling back to the working directory', async () => {
  const missing = webFixture();
  writeFileSync(missing.config, readFileSync(missing.config, 'utf8').replace('fixture.db', 'never-initialized.db'));
  await expect(serve(missing.config)).rejects.toThrow(/initialized|open|instance/i);
});
