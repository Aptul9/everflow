import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { stateGet, ticketGet, actionPost } from '../src/web/api.ts';
import { initialize, release } from '../src/web/instance.ts';
import { canonicalJson, readState, representation, ticketDetail } from '../src/web/state.ts';
import { webFixture } from './web-fixture.ts';

test('import and direct route handlers fail closed without a context or default DB access', async () => {
  const response = stateGet(new Request('http://localhost:1234/api/state', { headers: { host: 'localhost:1234' } }));
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe('instance.unavailable');
  expect(ticketGet(new Request('http://localhost:1234/api/ticket/1'), '1').status).toBe(503);
  expect((await actionPost(new Request('http://localhost:1234/api/ticket/1/start', { method: 'POST', body: '{}' }), 'ticket', '1', 'start')).status).toBe(503);
  const scratch = webFixture();
  const absent = resolve(scratch.root, 'data', 'dispatcher.db');
  const script = `import {stateGet} from ${JSON.stringify(pathToFileURL(resolve('dist/web/api.js')).href)};
    const result=stateGet(new Request('http://localhost:1234/api/state')); console.log(result.status);`;
  expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: scratch.root, encoding: 'utf8' }).trim()).toBe('503');
  expect(existsSync(absent)).toBe(false);
});

test('canonical JSON sorts nested keys and retains deterministic array order', () => {
  expect(canonicalJson({ z: { b: 2, a: 1 }, a: [{ b: 2, a: 1 }, 3] })).toBe('{"a":[{"a":1,"b":2},3],"z":{"a":1,"b":2}}');
});

test('timeline-only insert changes deterministic overview ETag without summary or activity changes', () => {
  const fixture = webFixture();
  using db = new DatabaseSync(fixture.path);
  const before = readState(db, fixture.cfg);
  const previous = representation(before);
  const ticketBefore = ticketDetail(db, fixture.proposal).ticket;
  db.prepare("INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (?,?,'failure','chat','Repeated dependency failure','timeline-only-regression')")
    .run(fixture.proposal, new Date().toISOString());
  const after = readState(db, fixture.cfg);
  expect(ticketDetail(db, fixture.proposal).ticket.summary).toBe(ticketBefore.summary);
  expect(ticketDetail(db, fixture.proposal).ticket.last_activity_at).toBe(ticketBefore.last_activity_at);
  expect(representation(after).etag).not.toBe(previous.etag);
  expect(representation(readState(db, fixture.cfg)).json).toBe(representation(after).json);
});

test('a missing initialized DB fails closed without creating an empty replacement on POST', async () => {
  const fixture = webFixture();
  const current = { config: fixture.cfg, configPath: fixture.cfg._config_path, port: 12345, token: 'a'.repeat(64) };
  initialize(current);
  try {
    renameSync(fixture.path, `${fixture.path}.retained`);
    const response = await actionPost(new Request('http://127.0.0.1:12345/api/ticket/1/start', { method: 'POST',
      headers: { host: '127.0.0.1:12345', origin: 'http://127.0.0.1:12345', 'x-dispatcher-token': current.token, 'content-type': 'application/json' }, body: '{}',
    }), 'ticket', '1', 'start');
    expect(response.status).toBe(503);
    expect(existsSync(fixture.path)).toBe(false);
  } finally { release(current); }
});

test('terminal groups use local calendar day across the UTC boundary', () => {
  const fixture = webFixture();
  using db = new DatabaseSync(fixture.path);
  db.prepare("UPDATE ticket SET closed_at='2026-11-06T07:30:00Z' WHERE id=?").run(fixture.done);
  db.prepare("UPDATE ticket SET closed_at='2026-11-06T08:30:00Z' WHERE id=?").run(fixture.dismissed);
  const script = `import {DatabaseSync} from 'node:sqlite';
    import {loadConfig} from ${JSON.stringify(pathToFileURL(resolve('dist/dispatcher/config.js')).href)};
    import {readState} from ${JSON.stringify(pathToFileURL(resolve('dist/web/state.js')).href)};
    using db=new DatabaseSync(${JSON.stringify(fixture.path)},{readOnly:true});
    const state=readState(db,loadConfig(${JSON.stringify(fixture.config)}),new Date('2026-11-06T09:00:00Z'));
    console.log(JSON.stringify(state.groups.done_today.map(ticket=>({id:ticket.id,stage:ticket.stage}))));`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8',
  });
  expect(JSON.parse(result)).toEqual([{ id: fixture.dismissed, stage: 'Dismissed' }]);
});

test('detail orders equal-time messages, refs and timeline deterministically newest first', () => {
  const fixture = webFixture();
  using db = new DatabaseSync(fixture.path);
  const at = '2026-11-06T08:00:00.000000Z';
  db.prepare("INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (?,?,'comment','you','first','phase6-first')").run(fixture.proposal, at);
  db.prepare("INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (?,?,'comment','you','second','phase6-second')").run(fixture.proposal, at);
  db.prepare("INSERT INTO ticket_ref(ticket,kind,key,url,seen_in) VALUES (?,'jira','AAA-1',NULL,'message')").run(fixture.proposal);
  const detail = ticketDetail(db, fixture.proposal);
  const equalTime = detail.timeline.filter((event) => event.at === at);
  expect(equalTime.map((event) => event.body)).toEqual(['second', 'first']);
  expect(detail.refs[0]!.key).toBe('AAA-1');
  const state = readState(db, fixture.cfg);
  expect(JSON.stringify(state)).not.toContain(fixture.config);
  expect(JSON.stringify(state)).not.toContain('HEALTH-SECRET');
});

test('a ticket card carries the newest triage reasoning', () => {
  const fixture = webFixture();
  using db = new DatabaseSync(fixture.path);
  expect(ticketDetail(db, fixture.proposal).ticket.reason).toBeNull();
  const event = db.prepare("INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (?,?,'triage','agent',?,?)");
  event.run(fixture.proposal, '2026-11-06T08:00:00.000000Z', 'New request', 'reason-old');
  event.run(fixture.proposal, '2026-11-06T08:05:00.000000Z', 'Same issue, owner changed', 'reason-new');
  db.prepare("INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (?,?,'comment','you','later comment','reason-comment')").run(fixture.proposal, '2026-11-06T08:10:00.000000Z');
  expect(ticketDetail(db, fixture.proposal).ticket.reason).toBe('Same issue, owner changed');
  expect(readState(db, fixture.cfg).groups.needs_you.find((ticket) => ticket.id === fixture.proposal)!.reason).toBe('Same issue, owner changed');
});

test('build entry points stay dynamic and never initialize an instance on import', () => {
  expect(readFileSync('src/app/page.tsx', 'utf8')).toContain("export const dynamic = 'force-dynamic'");
  expect(readFileSync('src/server.ts', 'utf8')).not.toContain('import.meta.main');
  expect(readFileSync('next.config.ts', 'utf8')).not.toContain("output: 'standalone'");
});
