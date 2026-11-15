import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { createKernel } from '../src/windows/kernel.ts';
import { runSource, watcherArguments } from '../src/watchers/source.ts';
import { sshQuery } from '../src/watchers/relay.ts';
import { SCRATCH } from './support.ts';

const scratch = resolve(SCRATCH);
function explicit(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || !resolve(value).toLowerCase().startsWith(scratch.toLowerCase() + sep)) throw new Error('fixture.explicit-scratch-required');
  return value;
}
const configPath = explicit(process.env.EVERFLOW_SOURCE_CONFIG);
const raw = parse(fs.readFileSync(configPath, 'utf8')) as any;
const input = explicit(raw.sources.teams.fixture_input), starts = explicit(raw.sources.teams.fixture_starts), exited = explicit(raw.sources.teams.fixture_exited);
const options = watcherArguments(process.argv.slice(2), { cache: { type: 'string' }, 'scratch-root': { type: 'string' }, profile: { type: 'string' }, 'bootstrap-cache': { type: 'string' } });
using kernel = createKernel();
const identity = kernel.processIdentity(process.pid);
fs.appendFileSync(starts, JSON.stringify({ at: new Date().toISOString(), source: 'teams', ...identity, parent: process.ppid, argv: process.argv, execArgv: process.execArgv, config_path: configPath, since: options.since, accounts: options.expectedAccounts }) + '\n');
let consumed = 0, ssh = false;
process.exitCode = await runSource('teams', options, async (signal) => {
  const bytes = fs.readFileSync(input);
  if (bytes.length > 1048576) throw new Error('fixture.input-limit');
  if (bytes.length > consumed) { process.stdout.write(bytes.subarray(consumed)); consumed = bytes.length; }
  if (raw.sources.teams.fixture_ssh && !ssh) {
    ssh = true;
    await sshQuery({ host: 'inert.invalid', root: '/inert', owner: 'synthetic@example.invalid' }, '/inert/never-opened.db', 'SELECT 1', signal,
      (_command, _args, childOptions) => spawn(process.execPath, ['-e', 'setTimeout(()=>process.stdout.end("[]"),120000)'], childOptions));
  }
}, { close: () => { fs.appendFileSync(exited, JSON.stringify({ at: new Date().toISOString(), source: 'teams', ...identity }) + '\n'); } });
