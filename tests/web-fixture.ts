import { writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/dispatcher/config.ts';
import { openDb } from '../src/dispatcher/db.ts';
import { enqueue, healthOk, park } from '../src/dispatcher/jobs.ts';
import { addRefs } from '../src/dispatcher/tickets.ts';
import { addBatch, proposed } from './chat-support.ts';
import { scratch } from './support.ts';

export function webFixture(flags: { tickets?: unknown; chats?: unknown } = {}) {
  const files = scratch('phase6-web-');
  writeFileSync(files.config, `[db]\npath = "fixture.db"\n[tickets]\nenabled = ${JSON.stringify(flags.tickets ?? true)}\n[chats]\nenabled = ${JSON.stringify(flags.chats ?? true)}\n[opencode]\nurl = "http://127.0.0.1:1"\npassword = "DO-NOT-SERIALIZE"\n[triage]\nproviders = ["synthetic"]\n`);
  const cfg = loadConfig(files.config);
  using db = openDb(files.path);
  const now = new Date().toISOString();
  const proposal = proposed(db, { title: 'Review synthetic access', confidence: 0.91, created_at: now, last_activity_at: now });
  const batch = addBatch(db, proposal, { text: '<script>untrusted()</script> literal source', conversation: 'phase6-source' });
  addRefs(db, proposal, [{ kind: 'jira', key: 'OPS-123', url: 'https://example.invalid/browse/OPS-123', seen_in: 'message' }], now);
  db.prepare('UPDATE ticket SET maybe_ticket=? WHERE id=?').run(proposal, proposed(db, { title: 'Second proposal', created_at: now }));
  const active = proposed(db, { title: 'Active synthetic work', lifecycle: 'active', approved_at: now, session_title: 'Verified remote title',
    report: 'working', report_line: 'Latest operational report', created_at: now });
  const waiting = proposed(db, { title: 'Waiting synthetic work', lifecycle: 'active', approved_at: now, report: 'waiting_them', created_at: now });
  const failed = proposed(db, { title: 'Failed synthetic work', lifecycle: 'active', approved_at: now, created_at: now });
  const failedJob = enqueue(db, 'forward', 'phase6-failed', { batch_ids: [] }, failed);
  park(db, failedJob, 'Synthetic parked failure');
  const unbound = enqueue(db, 'triage', 'phase6-unbound', { batch, assessment_error: { raw: '<bad-model-output>', parse_error: 'Expected JSON object' } });
  park(db, unbound, 'Synthetic triage failure');
  const done = proposed(db, { title: 'Done synthetic work', lifecycle: 'done', closed_at: now, created_at: now });
  const dismissed = proposed(db, { title: 'Dismissed synthetic work', lifecycle: 'dismissed', closed_at: now, created_at: now });
  proposed(db, { title: 'Old terminal work', lifecycle: 'done', closed_at: '2025-01-01T12:00:00Z', created_at: now });
  const skipped = skippedBatch(db, 'not_on_us');
  const backlog = skippedBatch(db, 'backlog');
  const answered = skippedBatch(db, 'answered');
  healthOk(db, 'outlook', now);
  healthOk(db, 'provider:synthetic', now, { token: 'HEALTH-SECRET', retry_at: null });
  db.prepare("INSERT INTO health(dependency,state,since,last_error) VALUES ('teams','failing',?,'Source unavailable')").run(now);
  db.prepare('INSERT INTO quarantine(source,line,error,at) VALUES (?,?,?,?)').run('synthetic', '<quarantined>', 'Invalid source record', now);
  db.prepare("INSERT INTO triage_log(batch,conversation,at,action,reason,raw) SELECT id,conversation,?,'invalid','Expected JSON object','<bad-model-output>' FROM batch WHERE id=?").run(now, batch);
  return { ...files, cfg, proposal, active, waiting, failed, failedJob, unbound, done, dismissed, skipped, backlog, answered };
}

function skippedBatch(db: DatabaseSync, outcome: 'not_on_us' | 'backlog' | 'answered'): number {
  const now = new Date().toISOString();
  const conversation = Number(db.prepare('INSERT INTO conversation(source,account,native_id,title) VALUES (?,?,?,?)')
    .run('synthetic', 'test@example.invalid', `skip-${outcome}`, `${outcome} source`).lastInsertRowid);
  return Number(db.prepare("INSERT INTO batch(conversation,state,outcome,created_at,done_at) VALUES (?,'done',?,?,?)")
    .run(conversation, outcome, now, now).lastInsertRowid);
}
