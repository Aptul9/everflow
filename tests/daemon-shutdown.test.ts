import { fork } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { isolatedEnvironment } from '../scripts/build.ts';
import { acquireInstance, bounded } from '../src/core/daemon.ts';
import { openDb, prepareStart } from '../src/core/db.ts';
import { enqueue } from '../src/core/jobs.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import { scratch } from './support.ts';

test('failed graceful shutdown retains the OS writer pipe until exact owned process termination', async () => {
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT), f = scratch('phase7b-shutdown-fence-');
  fs.writeFileSync(f.config, '[db]\npath="fixture.db"\n[tickets]\nenabled=false\n[chats]\nenabled=false\n[opencode]\nurl="http://127.0.0.1:1"\ntimeout_seconds=1\n');
  {
    using db = openDb(f.path); const at = new Date().toISOString(); prepareStart(db);
    const ticket = Number(db.prepare("INSERT INTO ticket(title,lifecycle,approved_at,session_id,created_at) VALUES ('Synthetic','active',?,'synthetic-session',?)").run(at, at).lastInsertRowid);
    const turn = Number(db.prepare("INSERT INTO turn(ticket,kind,prompt_id,text,session_id,state,created_at) VALUES (?,'forward','synthetic-prompt','Immutable','synthetic-session','admitted',?)").run(ticket, at).lastInsertRowid);
    enqueue(db, 'collect', 'synthetic-ignored-abort', { turn }, ticket);
  }
  const program = join(f.root, 'synthetic-shutdown-fault.mjs');
  fs.writeFileSync(program, `import {startDaemon} from ${JSON.stringify(pathToFileURL(artifact.server).href)};
    globalThis.fetch=()=>{process.send({type:'fetch-started'});return new Promise(()=>{});};
    const daemon=await startDaemon({configPath:${JSON.stringify(f.config)},buildReceipt:${JSON.stringify(process.env.TEST_BUILD_RECEIPT)},runId:${JSON.stringify(randomUUID())},port:0});
    process.send({type:'ready',receipt:daemon.receipt});
    process.on('message',async value=>{if(value?.stop){try{await daemon.close();process.send({type:'closed',code:'unexpected-success'});}catch(error){process.send({type:'closed',code:error.code||error.message});}}});`);
  const child = fork(program, [], { cwd: artifact.root, env: { ...isolatedEnvironment(artifact.root, process.env), EVERFLOW_ARTIFACT: process.env.TEST_BUILD_RECEIPT! }, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = ''; child.stdout!.on('data', (part: Buffer) => { stdout += part.toString(); }); child.stderr!.on('data', (part: Buffer) => { stderr += part.toString(); });
  const entered = Promise.withResolvers<void>(), closed = Promise.withResolvers<string>(), events: unknown[] = [];
  let ready = false, fetched = false;
  child.on('message', (value: any) => {
    events.push(value); if (value.type === 'ready') ready = true; if (value.type === 'fetch-started') fetched = true;
    if (ready && fetched) entered.resolve(); if (value.type === 'closed') closed.resolve(value.code);
  });
  child.once('error', entered.reject);
  const exit = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let probe: Awaited<ReturnType<typeof acquireInstance>> | undefined;
  try {
    await bounded(entered.promise, 20000, 'fixture.startup-deadline');
    child.send({ stop: true });
    expect(await bounded(closed.promise, 10000, 'fixture.shutdown-deadline')).toBe('jobs.stop-timeout');
    let acquired = false;
    try { probe = await acquireInstance(f.path); acquired = true; } catch (error) { expect((error as Error).message).toBe('daemon.already-running'); }
    expect(acquired).toBe(false);
  } finally {
    await probe?.close(); child.kill(); await bounded(exit, 10000, 'fixture.exit-deadline');
    fs.writeFileSync(join(f.root, 'stdout.log'), stdout); fs.writeFileSync(join(f.root, 'stderr.log'), stderr);
    fs.writeFileSync(join(f.root, 'proof.json'), JSON.stringify({ config: f.config, artifact: process.env.TEST_BUILD_RECEIPT, events, childExit: child.exitCode, childSignal: child.signalCode }, null, 2));
  }
  const next = await acquireInstance(f.path); await next.close();
});
