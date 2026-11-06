import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { plainParents, readBuildReceipt, samePath } from './web/build-artifact.ts';

export const HELP = `Manual inbox dispatcher
Usage: npm run inbox -- --artifact ABSOLUTE_BUILD_RECEIPT --config ABSOLUTE_CONFIG COMMAND
       node ABSOLUTE_STAGED_DIST_CLI --artifact ABSOLUTE_BUILD_RECEIPT --config ABSOLUTE_CONFIG COMMAND
Artifact may also be supplied explicitly through INBOX_DISPATCHER_ARTIFACT.
No default configuration, checkout artifact or newest-stage fallback exists.

Commands:
  start [--port 0..65535]       Manual native startup; 0 selects an owned loopback port
  stop                        Graceful owned stop, exact-identity bounded fallback
  status                      Read-only status; no migration or first-start cutoff
  ticket show ID
  ticket merge SOURCE_ID TARGET_ID
  ticket relink CONVERSATION_ID TARGET_ID
  ticket close ID [--reason TEXT]
  job list
  job retry ID
  job park ID [--reason TEXT]
  quarantine replay ID | --all
  --help                      Opens no config or database
`;

export class CliError extends Error { readonly code = 'cli.arguments'; }
export function childEnvironment(): NodeJS.ProcessEnv & Record<string, string> {
  const removed = new Set(['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE']);
  return { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !removed.has(entry[0].toUpperCase()))), NODE_ENV: process.env.NODE_ENV ?? 'production' };
}
export interface Command {
  name: string; args: number[]; configPath?: string; buildReceipt?: string; port?: number; reason?: string; all?: boolean; runId?: string;
}

export function parseCommand(args: string[], artifactEnvironment = process.env.INBOX_DISPATCHER_ARTIFACT): Command {
  const parsed = (() => {
    try { return parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
      help: { type: 'boolean', short: 'h' }, config: { type: 'string' }, artifact: { type: 'string' }, port: { type: 'string' },
      reason: { type: 'string' }, all: { type: 'boolean' }, 'run-id': { type: 'string' },
    } }); } catch { throw new CliError('cli.arguments'); }
  })();
  const { values, positionals } = parsed;
  const names = (parsed.tokens ?? []).filter((token) => token.kind === 'option').map((token) => token.name);
  if (new Set(names).size !== names.length) throw new CliError('cli.arguments');
  if (values.help || !args.length || positionals[0] === 'help') return { name: 'help', args: [] };
  const name = positionals.slice(0, ['ticket', 'job', 'quarantine'].includes(positionals[0] ?? '') ? 2 : 1).join(' ');
  const count: Record<string, number> = { start: 0, stop: 0, status: 0, 'ticket show': 1, 'ticket merge': 2, 'ticket relink': 2, 'ticket close': 1,
    'job list': 0, 'job retry': 1, 'job park': 1, 'quarantine replay': values.all ? 0 : 1, _run: 0 };
  if (!(name in count)) throw new CliError('cli.arguments');
  const rest = positionals.slice(name.includes(' ') ? 2 : 1);
  if (rest.length !== count[name] || rest.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new CliError('cli.arguments');
  if (values.all && name !== 'quarantine replay' || values.port !== undefined && !['start', '_run'].includes(name)
    || values.reason !== undefined && !['job park', 'ticket close'].includes(name) || values['run-id'] !== undefined && name !== '_run') throw new CliError('cli.arguments');
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (typeof values.port !== 'string' || !/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 0 || port > 65535)) throw new CliError('cli.arguments');
  if (typeof values.config !== 'string' || !isAbsolute(values.config) || values.config.includes('\0')) throw new CliError('cli.arguments');
  const artifact = values.artifact ?? artifactEnvironment;
  if (typeof artifact !== 'string' || !isAbsolute(artifact) || artifact.includes('\0')) throw new CliError('cli.arguments');
  if (name === '_run' && (typeof values['run-id'] !== 'string' || !/^[a-f0-9-]{36}$/i.test(values['run-id']))) throw new CliError('cli.arguments');
  return { name, args: rest.map(Number), configPath: resolve(values.config), buildReceipt: resolve(artifact),
    ...(port === undefined ? {} : { port }), ...(typeof values.reason === 'string' ? { reason: values.reason } : {}),
    ...(values.all ? { all: true } : {}), ...(typeof values['run-id'] === 'string' ? { runId: values['run-id'] } : {}) };
}

export function cliFailure(error: unknown): { error: { code: string; reason?: string; native_status?: number } } {
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown; reason?: unknown; status?: unknown } : {};
  const code = value.code === 'source.invalid-record' && typeof value.message === 'string' && /^(source|quarantine)\.[a-z0-9.-]+$/.test(value.message) ? value.message
    : typeof value.code === 'string' && /^[a-z][a-z0-9.-]+$/.test(value.code) ? value.code
    : typeof value.message === 'string' && /^(source|quarantine)\.[a-z0-9.-]+$/.test(value.message) ? value.message : 'cli.failed';
  return { error: { code, ...(typeof value.reason === 'string' && /^[A-Z_0-9.-]+$/.test(value.reason) ? { reason: value.reason } : {}),
    ...(Number.isSafeInteger(value.status) ? { native_status: Number(value.status) } : {}) } };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const command = parseCommand(args);
  if (command.name === 'help') { process.stdout.write(HELP); return 0; }
  const artifact = readBuildReceipt(command.buildReceipt);
  const cli = join(artifact.root, 'dist', 'cli.js');
  plainParents(cli);
  if (!fs.lstatSync(cli).isFile()) throw new CliError('cli.arguments');
  if (!samePath(fileURLToPath(import.meta.url), cli)) {
    const child = spawnSync(process.execPath, [cli, ...args], { cwd: artifact.root, env: childEnvironment(), windowsHide: true, stdio: 'inherit' });
    if (child.error) throw child.error;
    return child.status ?? 1;
  }
  process.chdir(artifact.root);
  process.env.INBOX_DISPATCHER_ARTIFACT = command.buildReceipt!;
  const { loadConfig } = await import('./dispatcher/config.ts');
  const cfg = loadConfig(command.configPath!);
  if (command.name === '_run') {
    try {
      const { startDaemon } = await import('./server.ts');
      const daemon = await startDaemon({ configPath: command.configPath!, buildReceipt: command.buildReceipt!, runId: command.runId!, ...(command.port === undefined ? {} : { port: command.port }) });
      await daemon.done;
      return 0;
    } catch (error) {
      const { atomicJson, instancePaths } = await import('./dispatcher/daemon.ts');
      atomicJson(instancePaths(cfg.db.path, command.runId!).ready, { status: 'error', run_id: command.runId, ...cliFailure(error).error });
      return 1;
    }
  }
  let result: unknown;
  if (['start', 'stop', 'status'].includes(command.name)) {
    const { launchDaemon, readStatus, stopDaemon } = await import('./dispatcher/daemon.ts');
    result = command.name === 'start' ? await launchDaemon(cfg, command.buildReceipt!, command.port)
      : command.name === 'stop' ? await stopDaemon(cfg) : await readStatus(cfg);
  } else {
    if (!fs.existsSync(cfg.db.path)) throw Object.assign(new Error('instance.unavailable'), { code: 'instance.unavailable' });
    const { DatabaseSync } = await import('node:sqlite');
    const write = !['ticket show', 'job list'].includes(command.name);
    using db = new DatabaseSync(cfg.db.path, { readOnly: !write, timeout: 30000 });
    if (db.prepare('PRAGMA user_version').get()!.user_version !== 2) throw Object.assign(new Error('instance.schema'), { code: 'instance.schema' });
    const { transaction } = await import('./dispatcher/db.ts');
    const tickets = await import('./dispatcher/tickets.ts');
    const jobs = await import('./dispatcher/jobs.ts');
    const operation = () => {
      const [one, two] = command.args;
      switch (command.name) {
        case 'ticket show': return tickets.detail(db, one!);
        case 'ticket merge': return { ticket: tickets.merge(db, one!, two!) };
        case 'ticket relink': return { ticket: tickets.relink(db, one!, two!) };
        case 'ticket close': return { ticket: tickets.close(db, one!, command.reason ?? '') };
        case 'job list': return db.prepare('SELECT * FROM job ORDER BY id').all();
        case 'job retry': case 'job park': {
          if (!db.prepare('SELECT 1 FROM job WHERE id=?').get(one!)) throw Object.assign(new Error('job.not-found'), { code: 'job.not-found' });
          if (command.name === 'job retry') jobs.retry(db, one!, { queued: true }); else jobs.park(db, one!, command.reason ?? 'Parked manually');
          return { job: one! };
        }
      }
      throw new CliError('cli.arguments');
    };
    // Replay owns its message/cursor/receipt transaction, including the --all rollback boundary.
    if (command.name === 'quarantine replay') result = (await import('./dispatcher/runtime.ts')).replayQuarantine(db, command.all ? 'all' : command.args[0]!);
    else if (write) result = transaction(db, operation);
    else { db.exec('BEGIN'); try { result = operation(); } finally { db.exec('ROLLBACK'); } }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

if (import.meta.main) void main().then((code) => { process.exitCode = code; }, (error: unknown) => { process.stderr.write(JSON.stringify(cliFailure(error)) + '\n'); process.exitCode = error instanceof CliError ? 2 : 1; });
