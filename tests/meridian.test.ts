import { expect, test } from 'vitest';
import { openDb } from '../src/core/db.ts';
import { assess } from '../src/core/kb-agent.ts';
import { ACCOUNT_CHECK_MAX_MS, ACCOUNT_CHECK_MS, applyAccounts, nextAccountCheck, readAccounts } from '../src/core/meridian.ts';
import type { AccountVerdict } from '../src/core/meridian.ts';
import { readState } from '../src/web/state.ts';
import { context, kbFixture, provider, scriptedPeer, text } from './kb-support.ts';

const AT = Date.parse('2026-11-14T08:00:00Z');
const RESET = Date.parse('2026-11-14T10:30:00Z');
const route = (profile?: string, baseURL = 'http://meridian.invalid/v1') => ({ settings: { baseURL, apiKey: 'k' }, headers: profile ? { 'X-Meridian-Profile': profile } : {} });
const quota = { profiles: [
  { id: 'notarify', windows: [{ type: 'five_hour', utilization: 0.46, resetsAt: RESET }, { type: 'seven_day', utilization: 0.16, resetsAt: RESET }, { type: 'seven_day_fable', utilization: 0 }], error: null, failure: null },
  { id: 'everbright', windows: [{ type: 'seven_day', utilization: 0.39 }], error: 'OAuth session expired and could not be refreshed', failure: null },
  { id: 'roar', windows: [{ type: 'five_hour', utilization: 1, resetsAt: RESET }, { type: 'seven_day', utilization: 0.31, resetsAt: RESET - 1 }], error: null, failure: null },
] };

function fakeFetch(reply: () => Response | Promise<Response>) {
  const calls: { url: string; headers: unknown }[] = [];
  return { calls, fetch: (async (url: string | URL, init?: RequestInit) => { calls.push({ url: String(url), headers: init?.headers }); return reply(); }) as typeof fetch };
}

test('one quota read per Meridian proxy gives each named profile its verdict; routes without a profile header are not checked', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['meridian-notarify', 'meridian-everbright', 'meridian-roar', 'meridian-gone', 'plain'];
  const peer = fakeFetch(() => Response.json(quota));
  const verdicts = await readAccounts(cfg, { fetch: peer.fetch, providers: { 'meridian-notarify': route('notarify'), 'meridian-everbright': route('everbright'),
    'meridian-roar': route('roar'), 'meridian-gone': route('gone'), plain: route() } });
  expect(peer.calls).toEqual([{ url: 'http://meridian.invalid/v1/usage/quota/all', headers: { 'x-api-key': 'k' } }]);
  expect(verdicts).toEqual([
    { id: 'meridian-notarify', state: 'ok', usage: { five_hour: 0.46, seven_day: 0.16 } },
    { id: 'meridian-everbright', state: 'unavailable', error: 'Meridian: OAuth session expired and could not be refreshed', usage: { seven_day: 0.39 } },
    { id: 'meridian-roar', state: 'limited', usage: { five_hour: 1, seven_day: 0.31 }, window: 'five_hour', resets_at: '2026-11-14T10:30:00.000Z' },
    { id: 'meridian-gone', state: 'unavailable', error: 'Meridian has no profile gone' },
  ]);
});

test('a failed usage refresh is not an account problem: cached windows still decide, a rate-limited usage read leaves health alone', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['stale', 'blind', 'full'];
  const failure = { reason: 'rate_limited', consecutiveFailures: 1, lastFailureAt: AT };
  const peer = fakeFetch(() => Response.json({ profiles: [
    { id: 'notarify', windows: [{ type: 'five_hour', utilization: 0.04, resetsAt: RESET }], error: null, failure, stale: true },
    { id: 'everbright', windows: [], error: 'rate_limited', failure },
    { id: 'roar', windows: [{ type: 'five_hour', utilization: 1, resetsAt: RESET }], error: 'rate_limited', failure },
  ] }));
  const verdicts = await readAccounts(cfg, { fetch: peer.fetch, providers: { stale: route('notarify'), blind: route('everbright'), full: route('roar') } });
  expect(verdicts).toEqual([
    { id: 'stale', state: 'ok', usage: { five_hour: 0.04 } },
    { id: 'blind', state: 'throttled' },
    { id: 'full', state: 'limited', usage: { five_hour: 1 }, window: 'five_hour', resets_at: '2026-11-14T10:30:00.000Z' },
  ]);
  const { cfg: other } = kbFixture();
  using db = openDb(other.db.path);
  applyAccounts(db, other, [{ id: 'blind', state: 'throttled' }], AT);
  expect(db.prepare('SELECT 1 FROM health WHERE dependency=?').get('provider:blind')).toBeUndefined();
});

test('the account check backs off exponentially while usage reads are throttled and resets on a clean read', () => {
  const throttled: AccountVerdict[] = [{ id: 'a', state: 'ok', usage: {} }, { id: 'b', state: 'throttled' }];
  const waits = [ACCOUNT_CHECK_MS];
  for (let n = 0; n < 4; n++) waits.push(nextAccountCheck(waits.at(-1)!, throttled));
  expect(waits.map((ms) => ms / 60_000)).toEqual([5, 10, 20, 30, 30]);
  expect(ACCOUNT_CHECK_MAX_MS).toBe(30 * 60_000);
  expect(nextAccountCheck(ACCOUNT_CHECK_MAX_MS, [{ id: 'a', state: 'ok', usage: {} }])).toBe(ACCOUNT_CHECK_MS);
});

test.each([
  ['an unreachable Meridian', () => { throw new TypeError('fetch failed'); }, 'fetch failed'],
  ['a Meridian error status', () => new Response('nope', { status: 500 }), 'Meridian quota HTTP 500'],
  ['an unexpected answer', () => Response.json({ accounts: [] }), 'Meridian quota response has an unexpected shape'],
])('%s leaves every route on that proxy to its triage calls', async (_name, reply) => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['a', 'b'];
  const verdicts = await readAccounts(cfg, { fetch: fakeFetch(reply).fetch, providers: { a: route('notarify'), b: route('roar') } });
  expect(verdicts).toEqual([{ id: 'a', state: 'throttled' }, { id: 'b', state: 'throttled' }]);
  using db = openDb(cfg.db.path);
  applyAccounts(db, cfg, verdicts, AT);
  expect(db.prepare("SELECT 1 FROM health WHERE dependency LIKE 'provider:%'").get()).toBeUndefined();
  await using peer = await scriptedPeer(() => ({ body: text() }));
  await assess(cfg, context(), [], 'new', undefined, { db, providers: { a: provider(peer.baseURL), b: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(1);
});

test('no providers file or no triage routes reads nothing', async () => {
  const { cfg } = kbFixture();
  const peer = fakeFetch(() => Response.json(quota));
  cfg.triage.provider_config_path = 'C:/missing/opencode.jsonc';
  expect(await readAccounts(cfg, { fetch: peer.fetch })).toEqual([]);
  cfg.triage.providers = [];
  expect(await readAccounts(cfg, { fetch: peer.fetch, providers: {} })).toEqual([]);
  expect(peer.calls).toEqual([]);
});

test('verdicts set health and retry: fine clears an older call backoff, limited waits for its reset, unavailable waits for the next check', () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  db.prepare(`INSERT INTO health(dependency,state,since,last_error,detail) VALUES ('provider:a','failing','2026-11-13T14:51:13Z','Provider a HTTP 500',?)`)
    .run(JSON.stringify({ retry_at: '2026-11-14T09:00:00.000Z', consecutive_errors: 4 }));
  const verdicts: AccountVerdict[] = [{ id: 'a', state: 'ok', usage: { seven_day: 0.39 } },
    { id: 'b', state: 'limited', usage: { five_hour: 1 }, window: 'five_hour', resets_at: '2026-11-14T10:30:00.000Z' },
    { id: 'c', state: 'unavailable', error: 'Meridian: OAuth session expired' }];
  applyAccounts(db, cfg, verdicts, AT);
  const row = (id: string) => { const r = db.prepare('SELECT state,last_error,detail FROM health WHERE dependency=?').get(`provider:${id}`)!; return { ...r, detail: JSON.parse(String(r.detail)) }; };
  expect(row('a')).toMatchObject({ state: 'ok', last_error: null, detail: { retry_at: null, consecutive_errors: 0, usage: { seven_day: 0.39 } } });
  expect(row('b')).toMatchObject({ state: 'failing', last_error: 'Limit reached (five-hour), resets 2026-11-14 10:30 UTC', detail: { retry_at: '2026-11-14T10:30:00.000000Z', usage: { five_hour: 1 } } });
  expect(row('c')).toMatchObject({ state: 'failing', last_error: 'Meridian: OAuth session expired', detail: { retry_at: new Date(AT + ACCOUNT_CHECK_MS).toISOString().replace('Z', '000Z') } });
  expect(row('c').detail.usage).toBeUndefined();
  const state = readState(db, { ...cfg, triage: { ...cfg.triage, providers: ['a', 'b', 'c'] } }, new Date(AT));
  expect(state.health.find((item) => item.dependency === 'provider:a')).toMatchObject({ state: 'ok', usage: { seven_day: 0.39 } });
});

test('triage skips an account Meridian reports limited and uses the next route', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['first', 'second'];
  using db = openDb(cfg.db.path);
  await using first = await scriptedPeer(() => ({ body: text() }));
  await using second = await scriptedPeer(() => ({ body: text() }));
  applyAccounts(db, cfg, [{ id: 'first', state: 'limited', usage: { five_hour: 1 }, window: 'five_hour', resets_at: new Date(Date.now() + 3_600_000).toISOString() }]);
  await assess(cfg, context(), [], 'new', undefined, { db, providers: { first: provider(first.baseURL), second: provider(second.baseURL) } });
  expect(first.requests).toHaveLength(0);
  expect(second.requests).toHaveLength(1);
  applyAccounts(db, cfg, [{ id: 'first', state: 'ok', usage: { five_hour: 0 } }]);
  await assess(cfg, context(), [], 'new', undefined, { db, providers: { first: provider(first.baseURL), second: provider(second.baseURL) } });
  expect(first.requests).toHaveLength(1);
});
