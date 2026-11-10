import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readBuildReceipt } from '../src/web/build-artifact.ts';

const { values } = parseArgs({ options: { root: { type: 'string' }, 'build-receipt': { type: 'string' } } });
const buildReceipt = values['build-receipt'] ?? process.env.TEST_BUILD_RECEIPT;
const artifact = readBuildReceipt(buildReceipt);
process.chdir(artifact.root);
const { startServer } = await import(pathToFileURL(artifact.server).href) as typeof import('../src/server.ts');
const { openDb } = await import(pathToFileURL(join(artifact.root, 'dist', 'dispatcher', 'db.js')).href) as typeof import('../src/dispatcher/db.ts');
const scratch = 'C:/Users/Antonio/AppData/Local/Temp/opencode/workdesk';
if (!values.root || !isAbsolute(values.root)) throw new Error('Explicit absolute --root inside approved scratch required');
const root = resolve(values.root);
const inside = relative(resolve(scratch), root);
if (!inside || inside.startsWith('..') || isAbsolute(inside) || existsSync(root)) throw new Error('Use a new directory inside approved scratch');
mkdirSync(root);
const configPath = join(root, 'config.toml');
writeFileSync(configPath, '[db]\npath = "showcase.db"\n[tickets]\nenabled = true\n[chats]\nenabled = true\n[opencode]\nurl = "http://127.0.0.1:1"\n[triage]\nproviders = ["synthetic"]\n');
{
  using db = openDb(join(root, 'showcase.db'));
  const now = new Date().toISOString();
  const ticket = db.prepare(`INSERT INTO ticket(title,client,summary,ask,proposal,confidence,kb_notes,lifecycle,report,report_line,session_title,created_at,last_activity_at,closed_at)
    VALUES (?,?,?,?,?,0.91,'["01_Projects/synthetic-access.md"]',?,?,?,?,?,?,?)`);
  ticket.run('Review synthetic access', 'Synthetic client', 'Read-only source context. No real provider configured.', 'Confirm requested scope.', 'Check existing membership first.',
    'proposed', null, null, null, now, now, null);
  ticket.run('Second synthetic proposal', 'Synthetic client', 'Bulk-dismiss comparison case.', 'Check duplicate request.', 'Read source evidence.',
    'proposed', null, null, null, now, now, null);
  ticket.run('Active investigation', 'Synthetic client', 'Approved local fixture.', '', '', 'active', 'working', 'Membership checked; awaiting instruction.', 'Verified synthetic session title', now, now, null);
  ticket.run('Waiting for vendor', 'Synthetic client', '', '', '', 'active', 'waiting_them', 'Written reply pending.', null, now, now, null);
  ticket.run('Failed collection', 'Synthetic client', '', '', '', 'active', null, null, null, now, now, null);
  ticket.run('Dismissed duplicate', 'Synthetic client', '', '', '', 'dismissed', 'done', 'Duplicate', null, now, now, now);
  ticket.run('Closed by hand', 'Synthetic client', '', '', '', 'done', 'done', 'Closed by hand', null, now, now, now);
  db.prepare("UPDATE ticket SET approved_at=? WHERE lifecycle='active'").run(now);
  db.prepare('UPDATE ticket SET maybe_ticket=1 WHERE id=2').run();
  db.prepare("INSERT INTO ticket_ref(ticket,kind,key,url,seen_in) VALUES (1,'jira','TEST-123','https://example.invalid/browse/TEST-123','message')").run();
  db.prepare("INSERT INTO conversation(source,account,native_id,title) VALUES ('synthetic','showcase@example.invalid','source-1','Synthetic source')").run();
  db.prepare("INSERT INTO ticket_conversation(ticket,conversation,kind,\"by\",created_at) VALUES (1,1,'primary','you',?)").run(now);
  db.prepare(`INSERT INTO message(source,message_id,conversation,sender,sender_is_me,sent_at,text,stored_at)
    VALUES ('synthetic','source-message-1',1,'Third party',0,?,'<script>untrusted()</script> stays literal source text.',?)`).run(now, now);
  db.prepare("INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (1,?,'message','Third party','Newest synthetic event','showcase-new')").run(now);
  db.prepare("INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (1,?,'triage','agent','Earlier synthetic event','showcase-old')").run(new Date(Date.now() - 60_000).toISOString());
  for (const outcome of ['not_on_us', 'backlog', 'answered']) {
    const conversation = db.prepare("INSERT INTO conversation(source,account,native_id,title) VALUES ('synthetic','showcase@example.invalid',?,?)").run(outcome, `${outcome} source`).lastInsertRowid;
    db.prepare("INSERT INTO batch(conversation,state,outcome,created_at,done_at) VALUES (?,'done',?,?,?)").run(conversation, outcome, now, now);
  }
  for (const [key, kind, owner] of [['failed-fixture', 'forward', 5], ['unbound-fixture', 'triage', null]] as const) {
    db.prepare("INSERT INTO job(kind,key,ticket,state,last_error,next_at,created_at,updated_at) VALUES (?,?,?,'parked','Synthetic parked error',?,?,?)").run(kind, key, owner, now, now, now);
  }
  for (const dependency of ['daemon', 'synthetic', 'provider:synthetic', 'opencode']) db.prepare("INSERT INTO health(dependency,state,since,last_error) VALUES (?,'stopped',?,'Synthetic fixture. No worker running.')").run(dependency, now);
  db.prepare("INSERT INTO quarantine(source,line,error,at) VALUES ('synthetic','<invalid source>','Synthetic parse failure',?)").run(now);
  db.prepare("INSERT INTO triage_log(at,action,reason,raw) VALUES (?,'invalid','Expected JSON object','<bad model output>')").run(now);
}
const server = await startServer({ configPath, buildReceipt: buildReceipt!, port: 0 });
console.log(JSON.stringify({ pid: process.pid, config: configPath, buildReceipt, url: `http://127.0.0.1:${server.port}`, synthetic: true }));
process.send?.({ ready: true, port: server.port, config: configPath });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void server.close().then(() => { process.disconnect?.(); }).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.once(signal, stop);
process.once('message', stop);
