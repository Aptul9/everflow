import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { utc } from './time.ts';

const positive = z.number().int().positive();
const nonnegative = z.number().int().nonnegative();
const rollout = z.object({ enabled: z.preprocess((value) => value === true, z.boolean()) }).prefault({ enabled: false });
const jobs = z.strictObject({
  triage_concurrency: positive.default(3),
  turn_concurrency: positive.default(4),
  lease_seconds: positive.default(120),
  renew_seconds: positive.default(30),
  backoff_initial_seconds: positive.default(10),
  backoff_max_seconds: positive.default(1800),
  backoff_jitter: z.number().min(0).max(1).default(0.2),
  max_attempts: positive.default(5),
  max_recoveries: nonnegative.default(2),
  dependency_failure_threshold: positive.default(3),
  collect_seconds: positive.default(10),
  sync_seconds: positive.default(300),
  heartbeat_seconds: positive.default(10),
  archive_hours: positive.default(24),
  reopen_days: nonnegative.default(2),
  purge_days: positive.default(30),
  log_max_bytes: positive.default(10485760),
  log_files: positive.default(5),
}).refine((value) => value.renew_seconds < value.lease_seconds, {
  path: ['renew_seconds'], message: 'renew_seconds must be less than lease_seconds',
}).refine((value) => value.backoff_initial_seconds <= value.backoff_max_seconds, {
  path: ['backoff_initial_seconds'], message: 'backoff initial must not exceed maximum',
}).prefault({});

const configSchema = z.looseObject({
  db: z.looseObject({ path: z.string().min(1) }),
  tickets: rollout,
  chats: rollout,
  vault: z.looseObject({ path: z.string().min(1).default('.'), guide: z.string().max(4_000).default('') }).prefault({}),
  opencode: z.looseObject({
    url: z.string().default(''), directory: z.string().min(1).default('.'), model: z.string().default(''),
    timeout_seconds: positive.max(120).optional(),
    // Empty url and a port: an OpenChamber web server (`openchamber serve`) on that loopback port, password from OPENCHAMBER_UI_PASSWORD
    openchamber_port: positive.max(65535).optional(),
  }).prefault({}),
  triage: z.looseObject({
    providers: z.array(z.string().min(1)).default([]), model: z.string().default(''),
    tool_limit: positive.max(8).default(8), timeout_seconds: positive.max(120).default(120),
    min_confidence: z.number().min(0).max(1).default(0.75), history_messages: nonnegative.max(100).default(40),
    provider_config_path: z.string().min(1).optional(),
  }).prefault({}),
  windows: z.looseObject({
    outlook: positive.min(300).default(300), teams: positive.min(120).default(120), teamsrelay: positive.min(120).default(120),
    gchat: positive.min(120).default(120), gmail: positive.min(300).default(300), oemail: positive.min(120).default(180),
    slack: positive.min(120).default(120),
  }).catchall(nonnegative).prefault({}),
  // The OE Copilot endpoint the OE-hosted sources read through (communication service /everflow/*), and the file holding
  // its read-only token, relative to this config
  oe: z.object({ url: z.url(), token_file: z.string().min(1) }).optional(),
  web: z.object({
    port: positive.max(65535).default(8789),
    // The HTTPS address a reverse proxy in front of the loopback port serves the page under (scheme and host, no path)
    public_origin: z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i, 'public_origin must be https://host[:port]').transform((value) => value.toLowerCase()).optional(),
  }).prefault({}),
  jobs,
  start: z.looseObject({
    triage_after: z.string({ error: 'triage_after must be a quoted aware timestamp' }).transform(utc).optional(),
    lookback_minutes: nonnegative.default(0),
  }).prefault({}),
  clients: z.record(z.string().min(1), z.looseObject({
    accounts: z.array(z.string()).default([]), domains: z.array(z.string()).default([]), keywords: z.array(z.string()).default([]),
    directory: z.string().min(1).optional(),
    // What is Antonio's work at this client, for triage (trusted text in its system prompt)
    role: z.string().max(2_000).optional(),
  })).default({}),
});

export type Config = z.infer<typeof configSchema> & { _config_path: string };

export function loadConfig(path: string): Config {
  const absolute = resolve(path);
  const root = dirname(absolute);
  const raw = parseToml(readFileSync(/* turbopackIgnore: true */ absolute, 'utf8'));
  for (const obsolete of ['mode', 'dispatch', 'approval', 'delivery', 'watchers']) delete raw[obsolete];
  const cfg = configSchema.parse(raw);
  return {
    ...cfg, _config_path: absolute,
    db: { ...cfg.db, path: resolve(root, cfg.db.path) },
    vault: { ...cfg.vault, path: resolve(root, cfg.vault.path) },
    opencode: { ...cfg.opencode, directory: resolve(root, cfg.opencode.directory) },
    triage: { ...cfg.triage, ...(cfg.triage.provider_config_path ? { provider_config_path: resolve(root, cfg.triage.provider_config_path) } : {}) },
    ...(cfg.oe ? { oe: { ...cfg.oe, token_file: resolve(root, cfg.oe.token_file) } } : {}),
    clients: Object.fromEntries(Object.entries(cfg.clients).map(([name, client]) =>
      [name, { ...client, ...(client.directory ? { directory: resolve(root, client.directory) } : {}) }])),
  };
}

export function readJsonc(path: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(readFileSync(/* turbopackIgnore: true */ path, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new SyntaxError(`Invalid JSONC in ${path}: ${errors.map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`).join(', ')}`);
  }
  return value;
}

export { chatDirectories, chatDirectory, clientsFor } from './policy.ts';
