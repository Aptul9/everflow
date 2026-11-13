import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Config } from './config.ts';
import { archive, collect, forward, startChat, sync } from './chat.ts';
import type { ChatOptions } from './chat.ts';
import { transaction } from './db.ts';
import { bounded, childEnvironment, DaemonError } from './daemon.ts';
import type { OwnedProcess } from './daemon.ts';
import { ingest, IngestError, schedule, sourceStart } from './ingest.ts';
import { claim, complete, defer, enqueue, fail, hasPendingInput, healthError, healthOk, owns, startRenewal } from './jobs.ts';
import type { Job } from './jobs.ts';
import { handleTriage } from './kb-agent.ts';
import { startRetitler, startSessionEvents } from './retitle.ts';
import { connect } from './opencode.ts';
import type { Peer } from './opencode.ts';
import { storeModelOptions, takeModelRequest } from './settings.ts';
import { sourceAccounts } from './policy.ts';
import { utc } from './time.ts';
import { createKernel, sameProcess, spawnedIdentity } from '../windows/kernel.ts';
import type { ProcessIdentity } from '../windows/kernel.ts';
import { TEAMS_NODE_FLAGS } from '../watchers/teams.ts';
import type { Source } from '../watchers/source.ts';
import { inside, plainParents, readBuildReceipt } from '../web/build-artifact.ts';
import { failureFields } from '../cli.ts';

const sources = ['outlook', 'teams', 'teamsrelay', 'gchat', 'gmail', 'oemail', 'slack'] as const;
const entrypoints = { outlook: 'outlook', teams: 'teams', teamsrelay: 'relay', gchat: 'gchat', gmail: 'gmail', oemail: 'oemail', slack: 'slack' };
const sourceSchema = z.looseObject({
  enabled: z.preprocess((value) => value === true, z.boolean()).default(false),
  entrypoint: z.string().min(1).optional(), poll_seconds: z.number().int().positive().max(86400).optional(),
  profile: z.string().min(1).optional(), bootstrap_cache: z.string().min(1).optional(),
  host: z.string().min(1).optional(), data_dir: z.string().min(1).optional(), owner: z.string().min(1).optional(),
  account: z.email().optional(), self_id: z.string().min(1).regex(/^\S+$/).optional(), workspace: z.string().regex(/^T[A-Z0-9]+$/).optional(), store: z.string().min(1).optional(),
  full_spaces: z.array(z.string().trim().min(1).refine((value) => !/[\r\n\0]/.test(value))).optional(), self_name: z.string().trim().min(1).optional(), executable: z.string().min(1).optional(), topics: z.number().int().min(1).max(1000).optional(),
  browser_refresh: z.preprocess((value) => value === true, z.boolean()).optional(),
  accounts: z.array(z.string().trim().min(1).refine((value) => value !== '*' && !/[\r\n\0]/.test(value))).optional(),
});
const sourceSettings = z.looseObject({ outlook: sourceSchema.optional(), teams: sourceSchema.optional(), teamsrelay: sourceSchema.optional(), gchat: sourceSchema.optional(), gmail: sourceSchema.optional(), oemail: sourceSchema.optional(), slack: sourceSchema.optional() });
type Event = { at?: string; source: string; code: string; [key: string]: unknown };
export type Log = (event: Event) => void;
const silent: Log = () => {};
const after = (at: string, seconds: number) => utc(new Date(Date.parse(at) + seconds * 1000).toISOString());

export function validateRuntimeConfig(cfg: Config, buildReceipt: string) {
  const artifact = readBuildReceipt(buildReceipt);
  const parsed = sourceSettings.safeParse(cfg.sources ?? {});
  if (!parsed.success) throw new DaemonError('source.config');
  for (const source of sources) {
    const value = parsed.data[source];
    if (!value?.enabled) continue;
    if (source === 'teams' && !value.profile) throw new DaemonError('source.profile-required');
    if (source === 'teamsrelay' && (!value.host || !value.data_dir || !value.owner)) throw new DaemonError('source.relay-options-required');
    if (source === 'oemail' && (!value.host || !value.accounts?.length)) throw new DaemonError('source.oemail-options-required');
    // Gmail through the OE agent may list several mailboxes under accounts instead of one account.
    if ((source === 'gchat' || source === 'gmail') && !value.account && !(source === 'gmail' && value.host && value.accounts?.length)) throw new DaemonError('source.google-account-required');
    if (source === 'gchat' && !value.self_id) throw new DaemonError('source.google-self-required');
    if (source === 'slack' && (!value.host || !value.account || !value.self_id || !value.workspace)) throw new DaemonError('source.slack-options-required');
    const entry = resolve(artifact.root, value.entrypoint ?? `dist/watchers/${entrypoints[source]}.js`);
    if (!inside(artifact.root, entry)) throw new DaemonError('source.artifact-entry');
    const staged = artifact.files.find((file) => resolve(artifact.root, file.path).toLowerCase() === entry.toLowerCase());
    if (entry !== join(artifact.root, 'dist', 'watchers', entrypoints[source] + '.js') && (!staged || !entry.endsWith('.ts'))) throw new DaemonError('source.artifact-entry');
    plainParents(entry);
    const stat = fs.lstatSync(entry);
    if (!stat.isFile() || stat.nlink !== 1 || staged && createHash('sha256').update(fs.readFileSync(entry)).digest('hex') !== staged.sha256) throw new DaemonError('source.artifact-entry');
    if (source === 'teams' && TEAMS_NODE_FLAGS.some((flag) => !process.allowedNodeEnvironmentFlags.has(flag))) throw new DaemonError('source.node-flags');
  }
  return { artifact, settings: parsed.data };
}

export function sourceCommand(cfg: Config, db: DatabaseSync, source: Source, buildReceipt: string, at?: string) {
  const { artifact, settings } = validateRuntimeConfig(cfg, buildReceipt);
  const value = settings[source];
  if (!value?.enabled) throw new DaemonError('source.disabled');
  const floor = sourceStart(db, cfg, source, at);
  const accounts = db.prepare("SELECT account FROM cursor WHERE source=? AND account<>'*' ORDER BY account").all(source).map((row) => String(row.account));
  const args = [...(source === 'teams' ? TEAMS_NODE_FLAGS : []), resolve(artifact.root, value.entrypoint ?? `dist/watchers/${entrypoints[source]}.js`), '--since', floor,
    ...accounts.flatMap((account) => ['--expected-account', account])];
  if (value.poll_seconds !== undefined) args.push('--poll', String(value.poll_seconds));
  const local = (path: string) => resolve(dirname(cfg._config_path), path);
  if (source === 'teams') {
    args.push('--cache', join(cfg.db.path + '.sources', 'teams-cache.dpapi'), '--scratch-root', join(cfg.db.path + '.sources', 'snapshots'), '--profile', local(value.profile!));
    if (value.bootstrap_cache) args.push('--bootstrap-cache', local(value.bootstrap_cache));
  }
  if (source === 'teamsrelay') args.push('--host', value.host!, '--data-dir', value.data_dir!, '--owner', value.owner!);
  if (source === 'oemail') args.push('--host', value.host!, ...value.accounts!.flatMap((account) => ['--account', account]));
  if (source === 'slack') args.push('--host', value.host!, '--account', value.account!, '--self-id', value.self_id!, '--workspace', value.workspace!, ...(value.store ? ['--store', value.store] : []));
  if (source === 'gchat' || source === 'gmail') {
    const mailboxes = source === 'gmail' && value.host && value.accounts?.length ? value.accounts : [value.account!];
    for (const account of new Set([...(value.account ? [value.account] : []), ...mailboxes])) args.push('--account', account);
    // host: read through the OE Copilot agent on that host instead of the local gweb/gws CLI
    if (value.host) args.push('--host', value.host);
    else if (value.executable) args.push('--executable', /[\\/]/.test(value.executable) ? local(value.executable) : value.executable);
    if (source === 'gchat') {
      args.push('--self-id', value.self_id!);
      if (value.topics !== undefined) args.push('--topics', String(value.topics));
      if (value.browser_refresh === true) args.push('--browser-refresh');
      for (const space of value.full_spaces ?? []) args.push('--full-space', space);
      if (value.self_name) args.push('--self-name', value.self_name);
    }
  }
  return { source, executable: process.execPath, args, cwd: artifact.root,
    environment: { ...childEnvironment(), EVERFLOW_SOURCE_OWNER: String(process.pid), EVERFLOW_SOURCE_CONFIG: cfg._config_path, EVERFLOW_ARTIFACT: buildReceipt } };
}

export function createLog(path: string, policy: Pick<Config['jobs'], 'log_files' | 'log_max_bytes'>): Log {
  return (event) => {
    const value: Record<string, unknown> = { at: utc(event.at), source: [...sources, 'daemon', 'jobs', 'next'].includes(event.source) ? event.source : 'daemon',
      code: /^[a-z][a-z0-9.-]{0,79}$/.test(event.code) ? event.code : 'log.invalid-code' };
    for (const key of ['job', 'quarantine', 'pid', 'status', 'count', 'bytes', 'exit_code']) if (Number.isSafeInteger(event[key])) value[key] = event[key];
    Object.assign(value, failureFields(event, event.stage));
    if (typeof event.run_id === 'string' && /^[a-f0-9-]{36}$/.test(event.run_id)) value.run_id = event.run_id;
    const text = JSON.stringify(value) + '\n', bytes = Buffer.byteLength(text);
    if (bytes > policy.log_max_bytes) return;
    if (fs.existsSync(path + '.log') && fs.statSync(path + '.log').size + bytes > policy.log_max_bytes) {
      for (let i = policy.log_files - 1; i > 0; i--) {
        const from = path + '.log' + (i === 1 ? '' : `.${i - 1}`);
        if (fs.existsSync(from)) fs.renameSync(from, path + `.log.${i}`);
      }
      if (policy.log_files === 1) fs.writeFileSync(path + '.log', '');
    }
    fs.appendFileSync(path + '.log', text);
  };
}

function prefix(bytes: Buffer, forced = false): { line: string; truncated: number } {
  const part = bytes.subarray(0, 4096);
  try {
    const line = new TextDecoder('utf-8', { fatal: true }).decode(part, { stream: true });
    return { line, truncated: Number(forced || bytes.length > part.length || Buffer.byteLength(line) !== part.length) };
  } catch {
    const line = part.toString('utf8');
    return { line: Buffer.from(line).subarray(0, 4096).toString('utf8').replace(/\uFFFD+$/, ''), truncated: 1 };
  }
}

function record(bytes: Buffer, source: string): unknown {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new IngestError('source.invalid-utf8'); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new IngestError('source.invalid-json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IngestError('source.invalid-record');
  if (!('source' in value) || value.source !== source) throw new IngestError('source.mismatch');
  return value;
}

const diagnosticCodes = new Set(`source.unexpected source.invalid-message source.since-required source.poll source.invalid-timestamp source.invalid-account source.option-required
cli.invalid-options cli.aborted cli.start cli.timeout cli.result-limit cli.failed cli.response-json
gchat.invalid-options gchat.account-mismatch gchat.response-shape gchat.message-limit
gmail.account-mismatch gmail.response-shape gmail.mime-shape gmail.mime-encoding gmail.body-unavailable gmail.message-time gmail.pagination-limit gmail.message-limit
slack.invalid-argument slack.invalid-options slack.invalid-host slack.invalid-limit slack.aborted slack.timeout slack.result-limit slack.ssh-start slack.ssh-failed slack.response-json slack.response-shape slack.api slack.account-mismatch slack.pagination-limit slack.message-limit
oemail.invalid-argument oemail.invalid-host oemail.invalid-limit oemail.aborted oemail.timeout oemail.result-limit oemail.ssh-start oemail.ssh-failed oemail.response-json oemail.response-shape oemail.http oemail.pagination oemail.message-shape oemail.message-time oemail.message-limit oemail.account-required oemail.account-unavailable
teams.scan-incomplete teams.accounts-missing teams.accounts-incomplete teams.region teams.origin teams.read-endpoint teams.refresh-account teams.http teams.response-json teams.response-limit teams.aborted teams.timeout teams.request-failed teams.response-shape teams.message-time teams.pagination-limit teams.page-shape teams.message-id
outlook.invalid-wall-clock outlook.collection-limit outlook.reference-cleanup outlook.accounts-unavailable outlook.accounts-incomplete outlook.account-mismatch outlook.read-failed outlook.not-running outlook.duplicate-account outlook.event-read-failed outlook.event-overflow outlook.newmail
relay.invalid-argument relay.absolute-path relay.invalid-host relay.invalid-limit relay.aborted relay.timeout relay.result-limit relay.ssh-start relay.ssh-failed relay.response-json relay.saved-json relay.saved-shape relay.invalid-slot relay.message-time relay.message-shape relay.app-unavailable relay.no-active-accounts relay.account-limit relay.scan-state relay.scan-incomplete relay.store-unavailable
auth.invalid-region auth.token-metadata auth.no-cookie-accounts auth.account-limit auth.cache-schema auth.cache-token auth.cache-separation auth.cache-read auth.cache-file auth.cache-json auth.cache-path auth.cache-parent auth.refresh-throttled auth.expired auth.profile-missing
cookie.unsupported-v21 cookie.invalid-length cookie.aes-authentication cookie.host-prefix
native.windows-x64-required native.invalid-handle native.duplicate-owner native.unowned native.cleanup native.invalid-argument native.abi-layout native.open-failed native.not-disk-file native.file-path native.file-path-limit native.file-path-mismatch native.mapping-size native.file-size native.file-identity native.file-attributes native.teams-not-running native.handle-inventory native.handle-inventory-query native.handle-inventory-limit native.file-size-changed
auth.cache-write auth.profile-path auth.profile-unavailable auth.local-state-unavailable auth.local-state-json auth.key-not-dpapi auth.invalid-key-length auth.no-valid-accounts auth.refresh-unavailable
snapshot.invalid-input snapshot.quick-check snapshot.cookie-version snapshot.cookie-row-limit snapshot.cookie-row snapshot.sqlite-read snapshot.copy-changed snapshot.absolute-source-required snapshot.unavailable snapshot.aborted snapshot.shared-open snapshot.source-unavailable snapshot.existence-changed snapshot.identity-changed snapshot.bytes-changed snapshot.capture-failed snapshot.cleanup
dpapi.abi-layout dpapi.transform dpapi.input-size dpapi.output-size dpapi.copy dpapi.cleanup
com.abi-layout com.initialize com.closed com.unowned com.unowned-point com.cleanup com.attach com.null-interface com.query-interface com.wrap-dispatch com.event-cookie`.split(/\s+/));

export function createSourceReader(db: DatabaseSync, cfg: Config, source: Source, log: Log = silent) {
  const publish: Log = (event) => log({ at: utc(), ...event });
  const allowed = sourceAccounts(cfg, source);
  // Messages of accounts switched off are dropped unstored; inventory and checkpoints still keep coverage complete.
  const off = (value: unknown) => {
    const item = value as Record<string, unknown>;
    return allowed !== null && !('checkpoint' in item) && !('accounts' in item) && typeof item.account === 'string' && !allowed.has(item.account.trim().toLowerCase());
  };
  const blocked = () => !!db.prepare('SELECT 1 FROM quarantine WHERE source=? AND replayed_at IS NULL LIMIT 1').get(source);
  const reject = (bytes: Buffer, error: IngestError, truncated: boolean) => {
    const saved = prefix(bytes, truncated), at = utc();
    const id = Number(db.prepare('INSERT INTO quarantine(source,line,error,at,truncated) VALUES (?,?,?,?,?)').run(source, saved.line, error.message, at, saved.truncated).lastInsertRowid);
    healthError(db, cfg, source, 'source.quarantined', at, true);
    publish({ at, source, code: 'source.quarantined', quarantine: id });
    return false;
  };
  return {
    get blocked() { return blocked(); },
    stdout(bytes: Buffer, truncated = false): boolean {
      try {
        if (truncated) throw new IngestError('source.line-limit');
        const value = record(bytes, source);
        if (blocked()) throw new IngestError('source.blocked-by-quarantine');
        if (off(value)) return false;
        const changed = ingest(db, value);
        if ('checkpoint' in (value as object)) {
          // Accounts the watcher could not read this round keep the failure it reports for them on stderr
          const failed = new Set(((value as { failed?: string[] }).failed ?? []).map((account) => account.toLowerCase()));
          healthOk(db, source);
          for (const row of db.prepare("SELECT account FROM cursor WHERE source=? AND account<>'*'").all(source)) {
            if (!failed.has(String(row.account).toLowerCase())) healthOk(db, `${source}:${row.account}`);
          }
        }
        return changed;
      } catch (error) {
        if (!(error instanceof IngestError)) throw error;
        return reject(bytes, error, truncated);
      }
    },
    stderr(bytes: Buffer, truncated = false): void {
      let value: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!truncated && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
      } catch { /* Never retain unstructured stderr, which can contain credentials. */ }
      const code = value?.source === source && typeof value.code === 'string' && diagnosticCodes.has(value.code) ? value.code : 'source.stderr-invalid';
      const status = Number.isSafeInteger(value?.status) ? Number(value!.status) : undefined;
      if (code === 'outlook.newmail') { publish({ source, code, count: Number(value?.count) }); return; }
      const account = typeof value?.account === 'string' && /^[a-z0-9._%+-]+@[a-z0-9.-]+$/i.test(value.account)
        && db.prepare('SELECT 1 FROM cursor WHERE source=? AND lower(account)=?').get(source, value.account.toLowerCase()) ? value.account.toLowerCase() : undefined;
      const reason = typeof value?.reason === 'string' && diagnosticCodes.has(value.reason) ? `: ${value.reason}` : '';
      healthError(db, cfg, account ? `${source}:${account}` : source, code + reason + (status === undefined ? '' : ` (${status})`), undefined, true);
      publish({ source, code, ...(status === undefined ? {} : { status }) });
    },
    ended(code: number | null, stopping = false): void {
      if (stopping) db.prepare("UPDATE health SET state='stopped' WHERE dependency=?").run(source);
      else healthError(db, cfg, source, 'source.exited', undefined, true);
      publish({ source, code: stopping ? 'source.stopped' : 'source.exited', ...(code === null ? {} : { exit_code: code }) });
    },
  };
}

async function lines(stream: Readable | null, consume: (line: Buffer, truncated: boolean) => unknown) {
  if (!stream) return;
  let pending = Buffer.alloc(0), overflow = false;
  for await (const data of stream) {
    const bytes = Buffer.from(data as Uint8Array);
    let at = 0;
    while (at < bytes.length) {
      const end = bytes.indexOf(10, at), piece = bytes.subarray(at, end < 0 ? bytes.length : end);
      if (!overflow && pending.length + piece.length <= 2 * 1024 * 1024) pending = Buffer.concat([pending, piece]);
      else { pending = Buffer.concat([pending, piece]).subarray(0, 4096); overflow = true; }
      if (end < 0) break;
      consume(pending.at(-1) === 13 ? pending.subarray(0, -1) : pending, overflow);
      pending = Buffer.alloc(0); overflow = false; at = end + 1;
    }
  }
  if (pending.length || overflow) consume(pending, overflow);
}

export async function readWatcher(db: DatabaseSync, cfg: Config, source: Source, child: ChildProcess, log: Log = silent, stopping: () => boolean = () => false) {
  const reader = createSourceReader(db, cfg, source, log);
  const terminal = new Promise<number | null>((resolve) => {
    child.once('error', () => { healthError(db, cfg, source, 'source.spawn-failed', undefined, true); });
    child.once('close', (code) => resolve(code));
  });
  let failed = false, failure: unknown;
  const readerFailed = (error: unknown) => {
    if (failed) return;
    failed = true; failure = error;
    if (child.connected) child.send({ type: 'everflow.stop' }, () => {}); else child.kill();
  };
  const stdout = lines(child.stdout, reader.stdout).then(() => {
    if (!stopping()) healthError(db, cfg, source, 'source.stdout-eof', undefined, true);
  }).catch(readerFailed);
  const stderr = lines(child.stderr, reader.stderr).catch(readerFailed);
  const [code] = await Promise.all([terminal, stdout, stderr]);
  reader.ended(code, stopping());
  if (failed) throw failure;
}

export function replayQuarantine(db: DatabaseSync, selection: number | 'all', at?: string) {
  return transaction(db, () => {
    const rows = selection === 'all' ? db.prepare('SELECT * FROM quarantine WHERE replayed_at IS NULL ORDER BY id').all()
      : db.prepare('SELECT * FROM quarantine WHERE id=?').all(selection);
    if (selection !== 'all' && !rows.length) throw new IngestError('quarantine.not-found');
    let replayed = 0, already = 0;
    for (const row of rows) {
      if (row.replayed_at) { already++; continue; }
      if (row.truncated) throw new IngestError('quarantine.truncated');
      if (db.prepare('SELECT 1 FROM quarantine WHERE source=? AND id<? AND replayed_at IS NULL').get(row.source!, row.id!)) throw new IngestError('quarantine.earlier-unreplayed-row');
      ingest(db, record(Buffer.from(String(row.line)), String(row.source)));
      db.prepare('UPDATE quarantine SET replayed_at=? WHERE id=? AND replayed_at IS NULL').run(utc(at), row.id!);
      replayed++;
    }
    return { replayed, already };
  });
}

export function scheduleMaintenance(db: DatabaseSync, cfg: Config, at?: string): void {
  transaction(db, () => {
    const now = utc(at), day = now.slice(0, 10);
    // A dismissed ticket gets a sync only until its session title says so. Titles otherwise move through stage marks and OpenCode
    // events (retitle.ts); this interval only repairs what those missed.
    for (const row of db.prepare(`SELECT id,lifecycle FROM ticket WHERE approved_at IS NOT NULL AND session_id IS NOT NULL
      AND (lifecycle<>'dismissed' OR COALESCE(session_title,'') NOT LIKE '[Skipped]%') ORDER BY id`).all()) {
      const ticket = Number(row.id);
      if (hasPendingInput(db, ticket)) continue;
      for (const kind of row.lifecycle === 'dismissed' ? ['sync'] as const : ['sync', 'archive'] as const) {
        if (db.prepare("SELECT 1 FROM job WHERE kind=? AND ticket=? AND state IN ('queued','running')").get(kind, ticket)) continue;
        const latest = db.prepare("SELECT next_at FROM job WHERE kind=? AND ticket=? AND state='done' ORDER BY updated_at DESC,id DESC LIMIT 1").get(kind, ticket);
        if (latest && utc(String(latest.next_at)) > now) continue;
        const key = `${kind}:ticket:${ticket}:${day}`;
        const existing = db.prepare('SELECT id,state,next_at FROM job WHERE key=?').get(key);
        if (!existing) enqueue(db, kind, key, {}, ticket);
        // A done run succeeded: its retry backoff starts over, so one blip later in the day waits seconds, not the day's failure count
        else if (existing.state === 'done' && utc(String(existing.next_at)) <= now) db.prepare(`UPDATE job SET state='queued',payload='{}',attempts=0,failures=0,
          error_class=NULL,last_error=NULL,next_at=?,updated_at=? WHERE id=? AND state='done'`).run(now, now, existing.id!);
      }
    }
    enqueue(db, 'purge', `purge:ticket:none:${day}`, {});
  });
}

export function heartbeat(db: DatabaseSync, metadata: Record<string, unknown>, at?: string) { healthOk(db, 'daemon', at, metadata); }

// Picker options: the models OpenChamber offers, for chats and, on the triage accounts, for triage.
// Provider names tell the accounts apart (Claude #1 (notarify)); without them the page shows provider ids.
export async function modelOptions(cfg: Config, peer: Pick<Peer, 'models' | 'providers'> = connect(cfg)) {
  const [chat, providers] = await Promise.allSettled([peer.models(), peer.providers()]);
  const message = (result: PromiseSettledResult<unknown>) => result.status === 'rejected' ? String((result.reason as Error)?.message ?? result.reason).slice(0, 200) : null;
  return {
    chat: chat.status === 'fulfilled' ? chat.value.filter((model) => model.enabled !== false && model.status !== 'deprecated')
      .map((model) => ({ id: `${model.providerID}/${model.modelID}`, name: model.name, efforts: model.variants.map((variant) => variant.id) }))
      .sort((a, b) => a.id.localeCompare(b.id)) : [],
    accounts: providers.status === 'fulfilled' ? Object.fromEntries(providers.value.map((provider) => [String(provider.id), provider.name])) : {},
    at: utc(), error: message(chat) && `Model list: ${message(chat)}`,
  };
}

export async function runJob(cfg: Config, db: DatabaseSync, job: Job, options: ChatOptions = {}) {
  if (job.kind === 'purge') {
    const now = () => utc(options.clock?.());
    complete(db, job, () => {
      db.prepare(`UPDATE message SET text=NULL WHERE text IS NOT NULL AND stored_at<? AND batch IN
        (SELECT b.id FROM batch b WHERE b.outcome='not_on_us' AND b.ticket IS NULL
          AND NOT EXISTS (SELECT 1 FROM ticket_conversation l WHERE l.conversation=b.conversation))`)
        .run(after(now(), -cfg.jobs.purge_days * 86400));
      db.prepare('UPDATE job SET next_at=? WHERE id=?').run(after(now(), 86400), job.id);
      healthOk(db, 'jobs:purge', now());
    }, now);
    return;
  }
  if (job.kind === 'triage') { await handleTriage(cfg, db, job, { ...options, ...(cfg.triage.provider_config_path ? { providerConfigPath: cfg.triage.provider_config_path } : {}) }); return; }
  const chatOptions = { ...options, ...(options.peer || cfg.opencode.timeout_seconds === undefined ? {} : { peer: connect(cfg, { timeoutMs: cfg.opencode.timeout_seconds * 1000 }) }) };
  await ({ start_chat: startChat, forward, collect, sync, archive })[job.kind](cfg, db, job, chatOptions);
}

type Handler = (cfg: Config, db: DatabaseSync, job: Job, options: ChatOptions) => void | Promise<void>;
export interface RuntimeOptions {
  buildReceipt: string; runId: string; restartAt?: string; metadata?: Record<string, unknown>;
  handlers?: Partial<Record<Job['kind'], Handler>>; spawnWatcher?: (command: ReturnType<typeof sourceCommand>) => ChildProcess;
  onChildren?: (children: OwnedProcess[]) => void; onHeartbeat?: () => void; onError?: (error: unknown) => void;
  // Session titles follow stage marks and the OpenCode event stream; the server turns it on when chats are on
  titles?: boolean;
}

function directory(path: string): void {
  let existing = path;
  while (!fs.existsSync(existing)) existing = dirname(existing);
  plainParents(existing);
  fs.mkdirSync(path, { recursive: true }); plainParents(path);
}

export async function startRuntime(cfg: Config, db: DatabaseSync, options: RuntimeOptions) {
  const { settings } = validateRuntimeConfig(cfg, options.buildReceipt);
  const log = createLog(cfg.db.path, cfg.jobs), registry = new Map<number, OwnedProcess>();
  const watchers: { child: ChildProcess; done: Promise<void> }[] = [];
  const inFlight = new Map<number, { controller: AbortController; done: Promise<void> }>();
  const reconcile = new Set(db.prepare("SELECT id FROM job WHERE state IN ('queued','running') AND (kind='collect' OR turn_id IS NOT NULL OR reserved_at IS NOT NULL)").all().map((row) => Number(row.id)));
  let native: ReturnType<typeof createKernel> | undefined, closing: Promise<void> | undefined, stopped = false, ticking = false;
  const kernel = () => native ??= createKernel();
  const changed = () => options.onChildren?.([...registry.values()]);
  const fatal = (error: unknown, stage: string) => {
    const fields = failureFields(error, stage);
    const failure = Object.assign(new DaemonError('runtime.failed'), fields);
    healthError(db, cfg, 'daemon', 'runtime.failed'); log({ source: 'daemon', code: 'runtime.failed', ...fields }); options.onError?.(failure);
  };
  let refreshing = false;
  // The page asks for picker options; one fetch at a time, failures kept with the old lists so the page can show them
  const refreshModels = () => {
    if (refreshing || !takeModelRequest(db)) return;
    refreshing = true;
    void modelOptions(cfg).then((value) => { if (!stopped) storeModelOptions(db, value); })
      .catch((error: unknown) => log({ source: 'daemon', code: 'models.refresh-failed', ...failureFields(error, 'models.refresh') }))
      .finally(() => { refreshing = false; });
  };
  function tick() {
    if (stopped || ticking) return;
    ticking = true;
    let stage = 'runtime.schedule';
    try {
      stage = 'runtime.models'; refreshModels();
      stage = 'runtime.schedule';
      schedule(db, cfg); stage = 'runtime.maintenance'; scheduleMaintenance(db, cfg);
      for (const id of reconcile) if (['done', 'cancelled', 'parked'].includes(String(db.prepare('SELECT state FROM job WHERE id=?').get(id)?.state))) reconcile.delete(id);
      for (;;) {
        stage = 'runtime.claim';
        const job = claim(db, cfg, options.runId, undefined, { runtime: true, inputReady: reconcile.size === 0 });
        if (!job) break;
        const controller = new AbortController();
        stage = 'runtime.renewal';
        const renewal = startRenewal(cfg, job, () => controller.abort());
        const jobOptions = { signal: controller.signal, buildReceipt: options.buildReceipt, log, ...(options.restartAt ? { restartAt: options.restartAt } : {}) };
        const done = Promise.resolve().then(() => (options.handlers?.[job.kind] ?? runJob)(cfg, db, job, jobOptions))
          .catch((error: unknown) => { if (!controller.signal.aborted) fail(db, cfg, job, error); log({ source: 'jobs', code: 'job.failed', job: job.id }); })
          .finally(() => {
            try {
              if (controller.signal.aborted && owns(db, job, utc())) defer(db, job, after(utc(), cfg.jobs.collect_seconds));
              const current = db.prepare('SELECT state,failures FROM job WHERE id=?').get(job.id);
              if (current && (['done', 'cancelled', 'parked'].includes(String(current.state)) || current.state === 'queued' && current.failures === job.failures && !controller.signal.aborted)) reconcile.delete(job.id);
            } finally { renewal.stop(); inFlight.delete(job.id); if (!stopped) queueMicrotask(tick); }
          });
        inFlight.set(job.id, { controller, done });
      }
    } catch (error) { fatal(error, stage); } finally { ticking = false; retitler?.wake(); }
  }
  // Marks written by another process (the chat's ticket CLI) are picked up at the next tick
  const retitler = options.titles ? startRetitler(cfg, db, { log }) : undefined;
  const events = retitler ? startSessionEvents(cfg, db, { wake: retitler.wake, log }) : undefined;
  const interval = setInterval(tick, cfg.jobs.collect_seconds * 1000);
  const beat = () => {
    let stage = 'heartbeat.store';
    try { heartbeat(db, { ...options.metadata, run_id: options.runId }); stage = 'heartbeat.receipt'; options.onHeartbeat?.(); }
    catch (error) { fatal(error, stage); }
  };
  const heartbeatTimer = setInterval(beat, cfg.jobs.heartbeat_seconds * 1000);
  interval.unref(); heartbeatTimer.unref();
  const close = () => closing ??= (async () => {
    stopped = true; clearInterval(interval); clearInterval(heartbeatTimer);
    retitler?.close(); await events?.close();
    for (const active of inFlight.values()) active.controller.abort();
    for (const { child } of watchers) if (child.connected) child.send({ type: 'everflow.stop' }, () => {});
    try { await bounded(Promise.allSettled(watchers.map((watcher) => watcher.done)), 5000, 'source.stop-timeout'); }
    catch {
      for (const { child } of watchers) if (child.exitCode === null && child.signalCode === null) child.kill();
      for (const identity of registry.values()) kernel().terminate(identity);
      await bounded(Promise.allSettled(watchers.map((watcher) => watcher.done)), 5000, 'source.stop-timeout');
    }
    await bounded(Promise.allSettled([...inFlight.values()].map((active) => active.done)), 5000, 'jobs.stop-timeout');
    for (const identity of registry.values()) kernel().terminate(identity);
    registry.clear(); changed(); native?.[Symbol.dispose]();
  })();
  try {
    for (const source of sources) {
      if (!settings[source]?.enabled) continue;
      if (source === 'teams') directory(join(cfg.db.path + '.sources', 'snapshots'));
      const command = sourceCommand(cfg, db, source, options.buildReceipt);
      const child = options.spawnWatcher ? options.spawnWatcher(command) : spawn(command.executable, command.args, { cwd: command.cwd, env: command.environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const done = readWatcher(db, cfg, source, child, log, () => stopped);
      let identity: OwnedProcess | undefined;
      const observed = done.catch((error: unknown) => { if (!stopped) fatal(error, 'source.reader'); }).finally(() => {
        if (!identity) return;
        for (const childIdentity of registry.values()) if (childIdentity.owner_pid === identity.pid && childIdentity.owner_created === identity.created) { kernel().terminate(childIdentity); registry.delete(childIdentity.pid); }
        const current = registry.get(identity.pid);
        if (current && sameProcess(current, identity)) registry.delete(identity.pid);
        changed();
      });
      watchers.push({ child, done: observed });
      const expected = await spawnedIdentity(child, (pid) => kernel().processIdentity(pid));
      identity = { ...expected, source, kind: 'watcher', owner_pid: process.pid,
        owner_created: typeof options.metadata?.created === 'string' ? options.metadata.created : kernel().processIdentity(process.pid).created };
      registry.set(identity.pid, identity); changed();
      const watcher = identity;
      child.on('message', (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const entry = value as { type?: unknown; identity?: ProcessIdentity; owner?: ProcessIdentity; pid?: unknown; active?: unknown; code?: unknown; status?: unknown };
        if (entry.type === 'everflow.child-error') { log({ source, code: 'source.child-identity', ...failureFields(entry, 'child.capture') }); return; }
        if (entry.type !== 'everflow.child') return;
        const valid = (item: unknown): item is ProcessIdentity => {
          if (!item || typeof item !== 'object') return false;
          const candidate = item as Partial<ProcessIdentity>;
          return Number.isSafeInteger(candidate.pid) && Number(candidate.pid) > 0 && typeof candidate.created === 'string' && /^\d+$/.test(candidate.created)
            && typeof candidate.image === 'string' && isAbsolute(candidate.image);
        };
        if (!valid(entry.identity) || !valid(entry.owner) || !sameProcess(entry.owner, watcher) || entry.pid !== entry.identity.pid) {
          log({ source, code: 'source.child-identity', ...failureFields({ reason: 'invalid-packet' }, 'child.packet') }); return;
        }
        const expectedChild = entry.identity;
        let stage = 'child.parent';
        try {
          if (entry.active === true) {
            if (!kernel().childOf(expectedChild, watcher)) {
              // A short SSH call often exits before its report arrives: nothing left to own, so only a live stranger is a mismatch
              if (kernel().running(expectedChild)) log({ source, code: 'source.child-identity', ...failureFields({ reason: 'identity-mismatch' }, stage) });
              return;
            }
            registry.set(expectedChild.pid, { ...expectedChild, source, kind: (source === 'gchat' || source === 'gmail') && !command.args.includes('--host') ? 'cli' : 'ssh', owner_pid: watcher.pid, owner_created: watcher.created });
          } else if (entry.active === false) {
            const registered = registry.get(expectedChild.pid);
            if (!registered || registered.owner_pid !== watcher.pid || registered.owner_created !== watcher.created || !sameProcess(registered, expectedChild)) return;
            registry.delete(expectedChild.pid);
          } else return;
          stage = 'child.publish'; changed();
        } catch (error) { log({ source, code: 'source.child-identity', ...failureFields(error, stage) }); }
      });
      log({ source, code: 'source.started', pid: identity.pid });
    }
    beat(); tick();
    return { close, children: () => [...registry.values()] };
  } catch (error) { await close(); throw error; }
}
