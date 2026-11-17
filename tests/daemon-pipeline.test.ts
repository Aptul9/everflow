import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { openDb } from '../src/core/db.ts';
import { loadConfig } from '../src/core/config.ts';
import { approve } from '../src/core/approval.ts';
import { enqueue } from '../src/core/jobs.ts';
import { createKernel } from '../src/windows/kernel.ts';
import { daemonFixture, sourceRecord } from './daemon-support.ts';
import { scriptedPeer as chatPeer } from './opencode-support.ts';
import { decision, provider, scriptedPeer as kbPeer, text, tools, use } from './kb-support.ts';
import { actionHeaders, http, rootToken } from './web-support.ts';
import { samePath } from '../src/web/build-artifact.ts';

test.each(['missing', 'false', '"true"'])('P01 actual daemon ingests inert source with tickets %s but starts no automatic work', async (flag) => {
  const f = daemonFixture(`${flag === 'missing' ? '' : `[tickets]\nenabled=${flag}\n`}[chats]\nenabled=true\n`);
  f.emit(sourceRecord());
  try {
    const start = await f.run('start', '--port', '0'); expect(start.status, start.stderr).toBe(0);
    const ready = JSON.parse(start.stdout);
    await f.until(() => f.read((db) => db.prepare('SELECT id FROM message').get()), 'ingested message');
    const first = f.read((db) => db.prepare("SELECT last_ok FROM health WHERE dependency='daemon'").get()!.last_ok);
    await f.until(() => f.read((db) => db.prepare("SELECT last_ok FROM health WHERE dependency='daemon'").get()!.last_ok !== first), 'next real heartbeat');
    expect(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM message').get()!.n)).toBe(1);
    expect(f.read((db) => db.prepare("SELECT COUNT(*) AS n FROM cursor WHERE source='teams' AND account='me@synthetic.invalid'").get()!.n)).toBe(1);
    expect(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM batch').get()!.n)).toBe(0);
    expect(f.read((db) => db.prepare("SELECT COUNT(*) AS n FROM job WHERE kind IN ('triage','start_chat','forward')").get()!.n)).toBe(0);
    expect(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM ticket').get()!.n)).toBe(0);
    const stop = await f.run('stop'); expect(stop.status, stop.stderr).toBe(0);
    await expect(http(ready.port, '/')).rejects.toThrow();
    f.proof({ requirement: 'P01', flag, ready, stopped: JSON.parse(stop.stdout) });
  } finally { await f.run('stop'); }
});

test('P02/P03 actual daemon owns one inert watcher and CLI child, excludes duplicate, releases pipe on stop/kill and preserves unrelated child', async () => {
  const f = daemonFixture('[tickets]\nenabled=false\n');
  fs.writeFileSync(f.config, fs.readFileSync(f.config, 'utf8').replace('poll_seconds=1', 'poll_seconds=1\nfixture_child=true'));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { cwd: f.artifact.root, windowsHide: true, stdio: 'ignore' });
  using kernel = createKernel();
  try {
    const started = await f.run('start', '--port', '0'); expect(started.status, started.stderr).toBe(0);
    const ready = JSON.parse(started.stdout);
    const owned = await f.until<any[]>(() => {
      const value = JSON.parse(fs.readFileSync(f.path + '.daemon.json', 'utf8'));
      return value.children.length === 2 && value.children;
    }, 'watcher and owned synthetic CLI registration');
    expect(owned.map((child: any) => child.kind).sort()).toEqual(['cli', 'watcher']);
    const duplicate = await f.run('start', '--port', '0'); expect(duplicate.status).not.toBe(0); expect(duplicate.stderr).toContain('daemon.already-running');
    expect(fs.readFileSync(f.starts, 'utf8').trim().split('\n')).toHaveLength(1);
    const stop = await f.run('stop'); expect(stop.status, stop.stderr).toBe(0); expect(JSON.parse(stop.stdout).forced).toBe(false);
    expect(owned.every((child: any) => !kernel.running(child))).toBe(true);
    expect(unrelated.exitCode).toBeNull();
    const again = await f.run('start', '--port', '0'); expect(again.status, again.stderr).toBe(0);
    const second = JSON.parse(again.stdout);
    const nextChildren = await f.until<any[]>(() => {
      const value = JSON.parse(fs.readFileSync(f.path + '.daemon.json', 'utf8')); return value.children.length === 2 && value.children;
    }, 'second owned children');
    expect(kernel.terminate(second)).toBe(true);
    for (const child of nextChildren) expect(kernel.wait(child, 5000)).toBe(true);
    expect(JSON.parse((await f.run('status')).stdout).running).toBe(false);
    const manual = await f.run('start', '--port', '0'); expect(manual.status, manual.stderr).toBe(0);
    expect(unrelated.exitCode).toBeNull();
    expect((await f.run('stop')).status).toBe(0);
    f.proof({ requirements: ['P02', 'P03'], ready, owned, killed: second, nextChildren, manual: JSON.parse(manual.stdout), unrelatedSurvived: true });
  } finally {
    await f.run('stop'); unrelated.kill();
    await new Promise<void>((resolve) => { if (unrelated.exitCode !== null || unrelated.signalCode !== null) resolve(); else unrelated.once('close', () => resolve()); });
  }
});

test('P04 reopened account inventory uses oldest floor in actual child argv and rejects a-only complete coverage', async () => {
  const f = daemonFixture('[tickets]\nenabled=false\n');
  const floor = new Date(Date.now() - 7200000).toISOString(), later = new Date(Date.now() - 3600000).toISOString();
  {
    using db = openDb(f.path);
    db.prepare('INSERT INTO cursor VALUES (?,?,?)').run('teams', '*', later);
    db.prepare('INSERT INTO cursor VALUES (?,?,?)').run('teams', 'a@synthetic.invalid', later);
    db.prepare('INSERT INTO cursor VALUES (?,?,?)').run('teams', 'b@synthetic.invalid', floor);
  }
  f.emit({ source: 'teams', accounts: ['a@synthetic.invalid', 'b@synthetic.invalid'] }, { source: 'teams', checkpoint: new Date().toISOString(), accounts: ['a@synthetic.invalid'] });
  try {
    const started = await f.run('start', '--port', '0'); expect(started.status, started.stderr).toBe(0);
    await f.until(() => f.read((db) => db.prepare('SELECT id FROM quarantine').get()), 'rejected partial checkpoint');
    const child = JSON.parse(fs.readFileSync(f.starts, 'utf8').trim());
    expect(child.argv[child.argv.indexOf('--since') + 1]).toBe(floor.replace('Z', '000Z'));
    expect(child.accounts).toEqual(['a@synthetic.invalid', 'b@synthetic.invalid']);
    expect(child.execArgv).toEqual(['--use-system-ca']);
    expect(f.read((db) => db.prepare("SELECT since FROM cursor WHERE source='teams' AND account='b@synthetic.invalid'").get()!.since)).toBe(floor);
    expect(f.read((db) => db.prepare("SELECT since FROM cursor WHERE source='teams' AND account='*'").get()!.since)).toBe(later);
    f.proof({ requirement: 'P04', child, floor, later });
  } finally { expect((await f.run('stop')).status).toBe(0); }
});

async function pipeline(configure?: (peer: Awaited<ReturnType<typeof chatPeer>>) => void, receipt = process.env.TEST_BUILD_RECEIPT) {
  const peer = await chatPeer();
  configure?.(peer);
  const kb = await kbPeer((_body, index) => ({ body: index === 0 ? tools(use('search', 'vault_search', { query: 'runtime-fixture' }))
    : index === 1 ? tools(use('read', 'vault_read', { path: '02_Areas/workflow.md' }))
      : text(JSON.stringify(decision({ title: 'Synthetic runtime ticket', client: 'synthetic', kb_notes: ['02_Areas/workflow.md'] }))) }));
  const f = daemonFixture(`[tickets]\nenabled=true\n[chats]\nenabled=true\n[opencode]\nurl=${JSON.stringify(peer.url)}\ndirectory="kb"\ntimeout_seconds=1\n[triage]\nproviders=["fixture"]\nmodel="synthetic-small"\nprovider_config_path="providers.jsonc"\ntimeout_seconds=5\n[clients.synthetic]\naccounts=["me@synthetic.invalid"]\n`, receipt);
  fs.mkdirSync(join(f.root, 'kb/02_Areas'), { recursive: true });
  fs.writeFileSync(join(f.root, 'kb/02_Areas/workflow.md'), '# Runtime workflow\n\nruntime-fixture: read-only synthetic evidence.\n');
  fs.writeFileSync(join(f.root, 'providers.jsonc'), JSON.stringify({ providers: { fixture: provider(kb.baseURL) } }));
  f.emit({ source: 'teams', accounts: ['me@synthetic.invalid'] }, sourceRecord());
  try {
    const started = await f.run('start', '--port', '0'); expect(started.status, started.stderr).toBe(0);
    const ready = JSON.parse(started.stdout);
    const proposed = await f.until(() => f.read((db) => db.prepare("SELECT * FROM ticket WHERE lifecycle='proposed'").get()), 'proposal from actual source/triage runtime');
    expect(peer.calls).toHaveLength(0);
    expect(kb.requests).toHaveLength(3);
    const note = 'Exact synthetic instruction\nKeep original source references.';
    const root = await http(ready.port, '/');
    const approval = await http(ready.port, `/api/ticket/${proposed.id}/chat`, { method: 'POST', headers: actionHeaders(ready.port, rootToken(root.text)), body: JSON.stringify({ note }) });
    expect(approval.status).toBe(200);
    return { ...f, peer, kb, ready, proposed, note,
      async close() { await f.run('stop'); await peer[Symbol.asyncDispose](); await kb[Symbol.asyncDispose](); },
    };
  } catch (error) { await f.run('stop'); await peer[Symbol.asyncDispose](); await kb[Symbol.asyncDispose](); throw error; }
}

test.each(['native', 'forward'])('P07 built chain retains terminal report/reference and explicit correction paths (%s receipt)', async (spelling) => {
  const selectedReceipt = spelling === 'forward' ? process.env.TEST_BUILD_RECEIPT!.replaceAll('\\', '/') : resolve(process.env.TEST_BUILD_RECEIPT!);
  const f = await pipeline(undefined, selectedReceipt);
  try {
    const first = await f.until(() => f.read((db) => db.prepare("SELECT * FROM turn WHERE state='admitted' ORDER BY id LIMIT 1").get()), 'first admitted immutable input');
    expect(String(first.text)).toContain(f.note); expect(String(first.text)).toContain('ABC-71');
    const command = String(first.text).split('\n').find((line) => line.startsWith('& '))!;
    const pathArgument = (name: string) => new RegExp(`${name} '((?:''|[^'])*)'`).exec(command)?.[1]?.replaceAll("''", "'");
    expect(command).toContain(`& '${process.execPath.replaceAll("'", "''")}' '${join(f.artifact.root, 'dist/cli.js').replaceAll("'", "''")}'`);
    expect(pathArgument('--artifact')).toBeDefined(); expect(samePath(pathArgument('--artifact')!, selectedReceipt)).toBe(true);
    expect(pathArgument('--config')).toBeDefined(); expect(samePath(pathArgument('--config')!, f.config)).toBe(true);
    expect(f.read((db) => db.prepare("SELECT raw FROM triage_log WHERE action='new'").get())?.raw).toContain('02_Areas/workflow.md');
    const store = f.read((db) => JSON.parse(String(db.prepare("SELECT detail FROM health WHERE dependency='daemon'").get()!.detail)).store_id);
    expect(f.peer.calls.find((call) => call.method === 'POST' && call.url.pathname === '/api/session')?.body.metadata)
      .toEqual({ everflow: { store_id: store, ticket: Number(f.proposed.id) } });
    expect(f.read((db) => db.prepare('SELECT key FROM ticket_ref ORDER BY id').all().map((row) => row.key))).toContain('ABC-71');
    f.peer.finish(String(first.session_id), String(first.prompt_id), 'STATUS: working | First input complete');
    await f.until(() => f.read((db) => db.prepare("SELECT id FROM turn WHERE id=? AND state='done'").get(first.id!)), 'first collection');
    f.emit(sourceRecord('later', 'Later synthetic input RITM12345'));
    const later = await f.until(() => f.read((db) => db.prepare("SELECT * FROM turn WHERE id>? AND state='admitted' ORDER BY id LIMIT 1").get(first.id!)), 'later forwarding to same session');
    expect(later.session_id).toBe(first.session_id);
    f.peer.deliver(String(later.session_id), String(later.prompt_id));
    await f.until(() => f.read((db) => db.prepare("SELECT id FROM job WHERE kind='collect' AND json_extract(payload,'$.turn')=? AND state='queued'").get(later.id!)), 'nonterminal collection retained');
    expect(f.read((db) => db.prepare('SELECT state FROM turn WHERE id=?').get(later.id!)!.state)).toBe('admitted');
    f.peer.finish(String(later.session_id), String(later.prompt_id), 'Terminal report reference CHG90077\nSTATUS: done | Later input complete');
    await f.until(() => f.read((db) => db.prepare("SELECT id FROM turn WHERE id=? AND state='done'").get(later.id!)), 'later terminal collection');
    expect(f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session')).toHaveLength(1);
    expect(f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/prompt'))).toHaveLength(2);
    expect(f.kb.requests).toHaveLength(3);
    expect(f.read((db) => db.prepare("SELECT COUNT(*) AS n FROM batch WHERE outcome='forwarded' AND state='done'").get()!.n)).toBe(2);
    const terminal = f.read((db) => db.prepare('SELECT lifecycle,report,report_line,report_message_id FROM ticket WHERE id=?').get(f.proposed.id!));
    expect(terminal).toEqual({ lifecycle: 'done', report: 'done', report_line: 'Later input complete', report_message_id: `asst_${later.prompt_id}` });
    expect(f.read((db) => db.prepare("SELECT ticket,kind,key,seen_in FROM ticket_ref WHERE key='CHG90077'").get()))
      .toEqual({ ticket: Number(f.proposed.id), kind: 'snow', key: 'CHG90077', seen_in: 'chat' });
    f.proof({ requirement: 'P07', spelling, selectedReceipt, ready: f.ready, first, later, terminal, peerCalls: f.peer.calls.map((call) => ({ method: call.method, path: call.url.pathname })), kbRequests: f.kb.requests.length });
  } finally { await f.close(); }
});

test('I1 actual CLI stop/restart reconciles accepted pre-turn create with chats off before resuming old then independent fresh input', async () => {
  const f = await pipeline((peer) => { peer.state.loseCreate = true; });
  try {
    const old = await f.until(() => f.read((db) => db.prepare("SELECT * FROM job WHERE kind='start_chat' AND turn_id IS NULL AND state='queued' AND failures>0").get()), 'lost accepted session-create response');
    expect(old.reserved_at).not.toBeNull(); expect(f.peer.sessions.size).toBe(1);
    const accepted = [...f.peer.sessions.keys()][0]!;
    expect((await f.run('stop')).status).toBe(0);
    let freshTicket: number;
    {
      using db = new DatabaseSync(f.path); const cfg = loadConfig(f.config);
      freshTicket = Number(db.prepare("INSERT INTO ticket(title,created_at) VALUES ('Independent restart input',?)").run(new Date().toISOString()).lastInsertRowid);
      approve(cfg, db, freshTicket, 'Explicit independent synthetic instruction');
    }
    fs.writeFileSync(f.config, fs.readFileSync(f.config, 'utf8').replace('[chats]\nenabled=true', '[chats]\nenabled=false'));
    expect((await f.run('start', '--port', '0')).status).toBe(0);
    await f.until(() => f.read((db) => db.prepare("SELECT t.id FROM ticket t JOIN job j ON j.ticket=t.id WHERE t.id=? AND t.session_id=? AND j.id=? AND j.state='queued' AND j.turn_id IS NULL").get(f.proposed.id!, accepted, old.id!)), 'chats-off accepted-tag lookup and durable defer');
    expect(f.read((db) => db.prepare('SELECT reserved_at,turn_id,state FROM job WHERE id=?').get(old.id!))).toMatchObject({ reserved_at: old.reserved_at, turn_id: null, state: 'queued' });
    expect(f.read((db) => db.prepare('SELECT COUNT(*) AS n FROM turn').get()!.n)).toBe(0);
    expect(f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session')).toHaveLength(1);
    expect(f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/prompt'))).toHaveLength(0);
    expect((await f.run('stop')).status).toBe(0);
    fs.writeFileSync(f.config, fs.readFileSync(f.config, 'utf8').replace('[chats]\nenabled=false', '[chats]\nenabled=true'));
    expect((await f.run('start', '--port', '0')).status).toBe(0);
    const original = await f.until(() => f.read((db) => db.prepare("SELECT * FROM turn WHERE ticket=? AND state='admitted'").get(f.proposed.id!)), 'old reserved input resumes');
    const fresh = await f.until(() => f.read((db) => db.prepare("SELECT * FROM turn WHERE ticket=? AND state='admitted'").get(freshTicket)), 'independent fresh input resumes');
    expect(original.session_id).toBe(accepted);
    const posts = f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/prompt'));
    expect(posts.map((call) => call.body.id)).toEqual([original.prompt_id, fresh.prompt_id]);
    expect(f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session')).toHaveLength(2);
    for (const turn of [original, fresh]) f.peer.finish(String(turn.session_id), String(turn.prompt_id), 'STATUS: done | Reconciled synthetic input');
    await f.until(() => f.read((db) => db.prepare("SELECT COUNT(*) AS n FROM turn WHERE state='done'").get()!.n === 2), 'both immutable inputs collected');
    f.proof({ requirement: 'I1-reserved-restart', old, accepted, original, fresh, originalSessionCreates: 1, chatsOffNewPosts: 0 });
  } finally { await f.close(); }
});

test('P09 chats-on unreachable history holds an otherwise eligible later queued input until original reconciliation/collection', async () => {
  let swallowed = false;
  const f = await pipeline((peer) => { peer.state.hook = (call) => {
    if (!swallowed && call.method === 'POST' && call.url.pathname.endsWith('/prompt')) {
      swallowed = true; const sessionID = decodeURIComponent(call.url.pathname.split('/')[3]!);
      peer.admissions.set(String(call.body.id), { id: String(call.body.id), sessionID, type: 'user', delivery: 'queue', time: { created: Date.now() }, payload: { text: String(call.body.text) } }); return true;
    }
    return false;
  }; });
  try {
    const old = await f.until(() => f.read((db) => db.prepare("SELECT * FROM job WHERE kind='start_chat' AND state='queued' AND failures>0").get()), 'uncertain original acceptance');
    const original = f.read((db) => db.prepare('SELECT * FROM turn WHERE id=?').get(old.turn_id!))!;
    f.emit(sourceRecord('eligible-later', 'Eligible later FIFO input'));
    const batch = await f.until(() => f.read((db) => db.prepare("SELECT b.id FROM batch b JOIN message m ON m.batch=b.id WHERE m.native_id='eligible-later' AND b.state='pending'").get()), 'later source batch ready');
    expect((await f.run('stop')).status).toBe(0);
    let laterJob: number;
    let correctionTarget: number;
    {
      using db = new DatabaseSync(f.path);
      laterJob = enqueue(db, 'forward', 'review:eligible-later-input', { batch_ids: [Number(batch.id)] }, Number(f.proposed.id));
      correctionTarget = Number(db.prepare("INSERT INTO ticket(title,created_at) VALUES ('Unapproved correction target',?)").run(new Date().toISOString()).lastInsertRowid);
    }
    const immutable = f.read((db) => ({ turn: db.prepare('SELECT * FROM turn WHERE id=?').get(original.id!),
      input: db.prepare('SELECT * FROM job WHERE id=?').get(old.id!), tail: db.prepare('SELECT * FROM job WHERE id=?').get(laterJob),
      messages: db.prepare('SELECT id,batch FROM message ORDER BY id').all(), links: db.prepare('SELECT * FROM ticket_conversation ORDER BY ticket,conversation').all() }));
    const conversation = f.read((db) => db.prepare('SELECT conversation FROM batch WHERE id=?').get(batch.id!)!.conversation)!;
    for (const args of [['ticket', 'relink', String(conversation), String(correctionTarget)], ['ticket', 'merge', String(f.proposed.id), String(correctionTarget)]]) {
      const refused = await f.run(...args);
      expect(refused.status).not.toBe(0); expect(refused.stderr).toContain('ticket.conflict');
    }
    expect(f.read((db) => ({ turn: db.prepare('SELECT * FROM turn WHERE id=?').get(original.id!),
      input: db.prepare('SELECT * FROM job WHERE id=?').get(old.id!), tail: db.prepare('SELECT * FROM job WHERE id=?').get(laterJob),
      messages: db.prepare('SELECT id,batch FROM message ORDER BY id').all(), links: db.prepare('SELECT * FROM ticket_conversation ORDER BY ticket,conversation').all() }))).toEqual(immutable);
    f.peer.state.historyStatus = 503;
    expect((await f.run('start', '--port', '0')).status).toBe(0);
    await f.until(() => f.read((db) => db.prepare("SELECT id FROM job WHERE id=? AND state='queued' AND failures>?").get(old.id!, old.failures!)), 'unreachable original history');
    const laterQueued = f.read((db) => db.prepare('SELECT state,next_at,reserved_at,turn_id FROM job WHERE id=?').get(laterJob))!;
    expect(laterQueued).toMatchObject({ state: 'queued', reserved_at: null, turn_id: null }); expect(Date.parse(String(laterQueued.next_at))).toBeLessThanOrEqual(Date.now());
    const cfg = loadConfig(f.config); expect(cfg.tickets.enabled && cfg.chats.enabled).toBe(true); expect(cfg.jobs.turn_concurrency).toBeGreaterThan(1);
    expect(f.read((db) => db.prepare('SELECT state FROM turn WHERE id=?').get(original.id!)!.state)).toBe('prepared');
    expect(f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
    f.peer.state.historyStatus = 200; f.peer.finish(String(original.session_id), String(original.prompt_id), 'STATUS: working | Original reconciliation complete');
    const retried = await f.run('job', 'retry', String(old.id)); expect(retried.status, retried.stderr).toBe(0);
    await f.until(() => f.read((db) => db.prepare("SELECT id FROM turn WHERE id=? AND state='done'").get(original.id!)), 'original collector releases FIFO');
    const later = await f.until(() => f.read((db) => db.prepare("SELECT * FROM turn WHERE id>? AND state='admitted'").get(original.id!)), 'later input becomes eligible');
    expect(later.session_id).toBe(original.session_id);
    expect(f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/prompt') && call.body.id === original.prompt_id)).toHaveLength(1);
    f.peer.finish(String(later.session_id), String(later.prompt_id), 'STATUS: done | Later FIFO input complete');
    await f.until(() => f.read((db) => db.prepare("SELECT id FROM turn WHERE id=? AND state='done'").get(later.id!)), 'later collection');
    f.proof({ requirement: 'P09-eligible-fifo', old, original, laterJob, laterQueued, later, correctionTarget, immutableCorrectionRefusals: 2, originalPosts: 1 });
  } finally { await f.close(); }
});

test('P09 actual HTTP acceptance timeout survives supported stop/restart and reconciles identical input with chats off', async () => {
  // Install the lost-response hook before approval by letting the first prompt hook retain the response.
  let swallowed = false;
  const f = await pipeline((peer) => { peer.state.hook = (call) => {
    if (!swallowed && call.method === 'POST' && call.url.pathname.endsWith('/prompt')) {
      swallowed = true;
      const sessionID = decodeURIComponent(call.url.pathname.split('/')[3]!);
      peer.admissions.set(String(call.body.id), { id: String(call.body.id), sessionID, type: 'user', delivery: 'queue', time: { created: Date.now() }, payload: { text: String(call.body.text) } });
      return true;
    }
    return false;
  }; });
  try {
    const failed = await f.until(() => f.read((db) => db.prepare("SELECT * FROM job WHERE kind='start_chat' AND state='queued' AND failures>0").get()), 'actual prompt response timeout');
    const original = f.read((db) => db.prepare('SELECT * FROM turn WHERE id=?').get(failed.turn_id!))!;
    const membership = f.read((db) => db.prepare('SELECT id,batch FROM message ORDER BY id').all())!;
    expect(failed.error_class).toBe('dependency'); expect(failed.lease_token).toBeNull(); expect(failed.reserved_at).not.toBeNull();
    expect(f.peer.admissions.has(String(original.prompt_id))).toBe(true);
    expect((await f.run('stop')).status).toBe(0);
    expect(f.peer.admissions.has(String(original.prompt_id))).toBe(true);
    fs.writeFileSync(f.config, fs.readFileSync(f.config, 'utf8').replace('[chats]\nenabled=true', '[chats]\nenabled=false'));
    f.peer.state.historyStatus = 503;
    expect((await f.run('start', '--port', '0')).status).toBe(0);
    const uncertain = await f.until(() => f.read((db) => db.prepare("SELECT * FROM job WHERE id=? AND state='queued' AND failures>?").get(failed.id!, failed.failures!)), 'unreachable restart history preserves uncertainty');
    expect(uncertain.error_class).toBe('dependency'); expect(uncertain.lease_token).toBeNull();
    expect(f.read((db) => db.prepare('SELECT state FROM turn WHERE id=?').get(original.id!)!.state)).toBe('prepared');
    expect(f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
    f.peer.state.historyStatus = 200;
    const retry = await f.run('job', 'retry', String(failed.id)); expect(retry.status, retry.stderr).toBe(0);
    await f.until(() => f.read((db) => db.prepare("SELECT id FROM turn WHERE id=? AND state='admitted'").get(original.id!)), 'restart reconciliation with chats off');
    const durable = f.read((db) => db.prepare('SELECT prompt_id,text,batch_ids,session_id FROM turn WHERE id=?').get(original.id!))!;
    expect(durable).toMatchObject({ prompt_id: original.prompt_id, text: original.text, batch_ids: original.batch_ids, session_id: original.session_id });
    expect(f.read((db) => db.prepare('SELECT id,batch FROM message ORDER BY id').all())).toEqual(membership);
    expect(f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
    expect(f.peer.calls.some((call) => /abort|cancel/.test(call.url.pathname))).toBe(false);
    f.peer.finish(String(original.session_id), String(original.prompt_id), 'STATUS: working | Collected after restart');
    await f.until(() => f.read((db) => db.prepare("SELECT id FROM turn WHERE id=? AND state='done'").get(original.id!)), 'chats-off admitted collector completes');
    f.proof({ requirement: 'P09', failed, uncertain, original, durable, membership, swallowed, originalAdmissions: 1, originalPosts: 1 });
  } finally { await f.close(); }
});

test('P08/P10 actual CLI retries failed admitted collector across another HTTP read timeout without stranded running or FIFO bypass', async () => {
  let deny = true, timeout = false;
  const f = await pipeline((peer) => { peer.state.hook = (call, response) => {
    if (call.method === 'GET' && call.url.pathname.endsWith('/message') && peer.admissions.size) {
      if (deny) { peer.json(response, { error: 'synthetic denied history' }, 403); return true; }
      if (timeout) { timeout = false; return true; }
    }
    return false;
  }; });
  try {
    const parked = await f.until(() => f.read((db) => db.prepare("SELECT * FROM job WHERE kind='collect' AND state='parked'").get()), 'real failed admitted collector');
    const original = f.read((db) => db.prepare('SELECT * FROM turn WHERE id=json_extract(?,\'$.turn\')').get(parked.payload!))!;
    const membership = f.read((db) => db.prepare('SELECT id,batch FROM message ORDER BY id').all());
    f.emit(sourceRecord('later', 'Later FIFO source input'));
    await f.until(() => f.read((db) => db.prepare('SELECT id FROM message WHERE native_id=?').get('later')), 'later input retained');
    deny = false; timeout = true;
    const firstRetry = await f.run('job', 'retry', String(parked.id)); expect(firstRetry.status, firstRetry.stderr).toBe(0);
    const retryable = await f.until(() => f.read((db) => db.prepare("SELECT * FROM job WHERE id=? AND state='queued' AND failures>0").get(parked.id!)), 'collector response timeout requeued');
    expect(retryable.error_class).toBe('dependency'); expect(retryable.lease_token).toBeNull(); expect(retryable.run_id).toBeNull();
    expect(f.read((db) => db.prepare('SELECT state FROM turn WHERE id=?').get(original.id!)!.state)).toBe('admitted');
    expect(f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/prompt'))).toHaveLength(1);
    f.peer.finish(String(original.session_id), String(original.prompt_id), 'STATUS: working | Retry succeeded');
    const secondRetry = await f.run('job', 'retry', String(parked.id)); expect(secondRetry.status, secondRetry.stderr).toBe(0);
    await f.until(() => f.read((db) => db.prepare("SELECT id FROM turn WHERE id=? AND state='done'").get(original.id!)), 'same original turn completes');
    const later = await f.until(() => f.read((db) => db.prepare("SELECT * FROM turn WHERE id>? AND state='admitted' ORDER BY id LIMIT 1").get(original.id!)), 'later FIFO input becomes eligible');
    expect(f.read((db) => db.prepare('SELECT id,batch FROM message WHERE id=?').get(membership![0]!.id!))).toEqual(membership![0]);
    expect(f.peer.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/prompt') && call.body.id === original.prompt_id)).toHaveLength(1);
    f.peer.finish(String(later.session_id), String(later.prompt_id), 'STATUS: done | FIFO tail complete');
    await f.until(() => f.read((db) => db.prepare("SELECT id FROM turn WHERE id=? AND state='done'").get(later.id!)), 'tail collection');
    f.proof({ requirements: ['P08', 'P10'], parked, original, retryable, later, originalPosts: 1, membership });
  } finally { await f.close(); }
});
