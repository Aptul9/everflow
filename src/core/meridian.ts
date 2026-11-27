import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Config } from './config.ts';
import { transaction } from './db.ts';
import { healthError, healthOk } from './jobs.ts';
import { routeSchema, triageProviders } from './kb-agent.ts';
import { utc } from './time.ts';

// Meridian answers for its accounts: one quota read per proxy says whether each triage route can serve now, so the health row and
// failover follow the account instead of the last triage call. Routes without an x-meridian-profile header keep call-based health.
// Each read makes Meridian ask Anthropic's usage endpoint for every profile once its 30 s cache is gone, and that endpoint rate limits
// per account across every Meridian signed into it; a limit hit between checks still reaches failover through the triage call itself.
export const ACCOUNT_CHECK_MS = 5 * 60_000;
export const ACCOUNT_CHECK_MAX_MS = 30 * 60_000;

const windowSchema = z.looseObject({ type: z.string(), utilization: z.number().nullish(), resetsAt: z.number().nullish() });
const quotaSchema = z.looseObject({ profiles: z.array(z.looseObject({ id: z.string(), error: z.unknown().optional(),
  windows: z.array(windowSchema).nullish() })) });

export type Usage = Partial<Record<'five_hour' | 'seven_day', number>>;
export type AccountVerdict = { id: string } & ({ state: 'ok'; usage: Usage } | { state: 'limited'; usage: Usage; window: string; resets_at: string }
  | { state: 'unavailable'; error: string; usage?: Usage } | { state: 'throttled' });

function problem(value: unknown): string | null {
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === 'string') return value;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' ? message : JSON.stringify(value).slice(0, 200);
}

/** Reads Meridian's quota for every triage route that names a Meridian profile. Writes nothing. */
export async function readAccounts(cfg: Config, options: { providers?: Readonly<Record<string, unknown>>; fetch?: typeof fetch } = {}): Promise<AccountVerdict[]> {
  if (!cfg.triage.providers.length) return [];
  let providers: Readonly<Record<string, unknown>>;
  try { providers = options.providers ?? triageProviders(cfg.triage.provider_config_path); } catch { return []; }
  const proxies = new Map<string, { id: string; profile: string; key: string | undefined }[]>();
  for (const id of new Set(cfg.triage.providers)) {
    const route = routeSchema.safeParse(providers[id]);
    const profile = route.success ? Object.entries(route.data.headers).find(([name]) => name.toLowerCase() === 'x-meridian-profile')?.[1] : undefined;
    if (!route.success || !profile) continue;
    const base = route.data.settings.baseURL.replace(/\/$/, '');
    proxies.set(base, [...(proxies.get(base) ?? []), { id, profile, key: route.data.settings.apiKey }]);
  }
  const verdicts: AccountVerdict[] = [];
  for (const [base, routes] of proxies) {
    let profiles: z.infer<typeof quotaSchema>['profiles'];
    try {
      const key = routes.find((route) => route.key)?.key;
      const response = await (options.fetch ?? fetch)(`${base}/usage/quota/all`, { redirect: 'error', signal: AbortSignal.timeout(10_000), ...(key ? { headers: { 'x-api-key': key } } : {}) });
      if (!response.ok) throw new Error(`Meridian quota HTTP ${response.status}`);
      profiles = quotaSchema.parse(await response.json()).profiles;
    } catch {
      // A quota read that fails says nothing about the accounts: the triage calls keep deciding health, so failover still runs
      for (const route of routes) verdicts.push({ id: route.id, state: 'throttled' });
      continue;
    }
    for (const route of routes) {
      const found = profiles.find((item) => item.id === route.profile);
      if (!found) { verdicts.push({ id: route.id, state: 'unavailable', error: `Meridian has no profile ${route.profile}` }); continue; }
      const windows = found.windows ?? [];
      const usage: Usage = Object.fromEntries(windows.filter((item) => (item.type === 'five_hour' || item.type === 'seven_day') && typeof item.utilization === 'number')
        .map((item) => [item.type, item.utilization]));
      // `failure` is only the last refresh that failed: with no `error` Meridian still serves its cached windows. `rate_limited` is the
      // usage endpoint refusing, not the account, so without a full window the health row stays with the triage calls.
      const error = problem(found.error);
      // The window that frees up last decides when the account can serve again
      const full = windows.filter((item) => (item.utilization ?? 0) >= 1 && typeof item.resetsAt === 'number').sort((a, b) => b.resetsAt! - a.resetsAt!)[0];
      if (error && error !== 'rate_limited') verdicts.push({ id: route.id, state: 'unavailable', error: `Meridian: ${error}`, usage });
      else if (full) verdicts.push({ id: route.id, state: 'limited', usage, window: full.type, resets_at: new Date(full.resetsAt!).toISOString() });
      else if (error) verdicts.push({ id: route.id, state: 'throttled' });
      else verdicts.push({ id: route.id, state: 'ok', usage });
    }
  }
  return verdicts;
}

/** The wait before the next check doubles while Meridian says the usage endpoint is rate limiting, and is back to the base once it answers. */
export function nextAccountCheck(previous: number, verdicts: readonly AccountVerdict[]): number {
  return verdicts.some((verdict) => verdict.state === 'throttled') ? Math.min(previous * 2, ACCOUNT_CHECK_MAX_MS) : ACCOUNT_CHECK_MS;
}

/** Health rows from the verdicts: an unavailable account is skipped until the next check, a limited one until its window resets,
 *  an account Meridian calls fine is tried again at once, whatever its last triage call did, and a throttled one keeps its row. */
export function applyAccounts(db: DatabaseSync, cfg: Config, verdicts: readonly AccountVerdict[], at = Date.now()): void {
  const now = utc(new Date(at).toISOString());
  transaction(db, () => {
    for (const verdict of verdicts) {
      const dependency = `provider:${verdict.id}`;
      if (verdict.state === 'throttled') continue;
      if (verdict.state === 'ok') { healthOk(db, dependency, now, { retry_at: null, usage: verdict.usage }); continue; }
      const limited = verdict.state === 'limited';
      healthError(db, cfg, dependency, limited ? `Limit reached (${verdict.window.replace('_', '-')}), resets ${verdict.resets_at.slice(0, 16).replace('T', ' ')} UTC` : verdict.error, now, true);
      const row = db.prepare('SELECT detail FROM health WHERE dependency=?').get(dependency)!;
      const detail = JSON.parse(String(row.detail)) as Record<string, unknown>;
      detail.retry_at = limited ? utc(verdict.resets_at) : utc(new Date(at + ACCOUNT_CHECK_MS).toISOString());
      if (verdict.usage) detail.usage = verdict.usage; else delete detail.usage;
      db.prepare('UPDATE health SET detail=? WHERE dependency=?').run(JSON.stringify(detail), dependency);
    }
  });
}
