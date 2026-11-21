import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolatedEnvironment } from '../scripts/build.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import { scratch } from './support.ts';

export function daemonFixture(settings = '', receipt = process.env.TEST_BUILD_RECEIPT) {
  const artifact = readBuildReceipt(receipt);
  const f = scratch('phase7b-chain ');
  const input = join(f.root, 'source.ndjson'), starts = join(f.root, 'source-starts.ndjson'), exited = join(f.root, 'source-exits.ndjson');
  fs.writeFileSync(input, ''); fs.writeFileSync(starts, ''); fs.writeFileSync(exited, '');
  const base = `[db]\npath="fixture.db"\n[vault]\npath="kb"\n[start]\nlookback_minutes=60\n[jobs]\ncollect_seconds=1\nheartbeat_seconds=1\nbackoff_initial_seconds=10\nbackoff_max_seconds=60\nbackoff_jitter=0\n[sources.teams]\nenabled=true\nentrypoint="tests/inert-watcher.ts"\npoll_seconds=1\nprofile=${JSON.stringify(join(f.root, 'never-read-profile'))}\nfixture_input=${JSON.stringify(input)}\nfixture_starts=${JSON.stringify(starts)}\nfixture_exited=${JSON.stringify(exited)}\n`;
  fs.writeFileSync(f.config, base + settings);
  const env = isolatedEnvironment(artifact.root, process.env), commands: unknown[] = [];
  let sequence = 0;
  const run = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const argv = [join(artifact.root, 'dist/cli.js'), '--artifact', receipt!, '--config', f.config, ...args];
    const child = spawn(process.execPath, argv, { cwd: artifact.root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', (value: Buffer) => { stdout += value.toString(); }); child.stderr!.on('data', (value: Buffer) => { stderr += value.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned CLI deadline')); }, 45000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (status) => {
      clearTimeout(timer);
      const name = String(++sequence).padStart(2, '0') + '-' + args[0];
      fs.writeFileSync(join(f.root, name + '.stdout.log'), stdout); fs.writeFileSync(join(f.root, name + '.stderr.log'), stderr);
      commands.push({ argv: [process.execPath, ...argv], cwd: artifact.root, status, stdout: name + '.stdout.log', stderr: name + '.stderr.log' });
      resolve({ status, stdout, stderr });
    });
  });
  function read<T>(operation: (db: DatabaseSync) => T): T | null {
    if (!fs.existsSync(f.path)) return null;
    using db = new DatabaseSync(f.path, { readOnly: true, timeout: 30000 });
    return operation(db);
  }
  function until<T>(operation: () => T | undefined | null | false, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      let watcher: fs.FSWatcher | undefined, settled = false, queued: NodeJS.Timeout | undefined;
      const finish = (error?: unknown, value?: T) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(queued); watcher?.close(); error ? reject(error) : resolve(value!); };
      const check = () => { queued = undefined; if (settled) return; try { const value = operation(); if (value) finish(undefined, value); } catch (error) { finish(error); } };
      const timer = setTimeout(() => finish(new Error(`Fixture deadline: ${label}`)), 20000);
      // libuv reads inotify events until none are left: a check run inside the event callback opens the database, which
      // raises new events in the same folder, and the read loop never returns (100% CPU, timers starved). Queue it instead.
      watcher = fs.watch(f.root, () => { queued ??= setTimeout(check, 10); }); watcher.once('error', (error) => finish(error)); check();
    });
  }
  return { ...f, artifact, input, starts, exited, base, commands, run, read, until,
    emit: (...values: unknown[]) => fs.appendFileSync(input, values.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n'),
    proof: (value: unknown) => fs.writeFileSync(join(f.root, 'proof.json'), JSON.stringify({ config: f.config, artifact: receipt, commands, value }, null, 2)),
  };
}

export function sourceRecord(id = 'first', text = 'Synthetic request ABC-71') {
  return { source: 'teams', account: 'me@synthetic.invalid', conversation_id: 'synthetic-conversation', message_id: id,
    conversation_title: 'Synthetic runtime request', sender_is_me: false, sender: 'sender@synthetic.invalid',
    sent_at: new Date(Date.now() - 600000).toISOString(), text, attachments: [{ name: 'synthetic.txt' }], ref: { chat: 'synthetic-conversation', id, account: 'me@synthetic.invalid' } };
}
