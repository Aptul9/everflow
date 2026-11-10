import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as api from '../src/dispatcher/kb-agent.ts';
import { openDb } from '../src/dispatcher/db.ts';
import { classify } from '../src/dispatcher/jobs.ts';
import { context, decision, kbFixture, provider, scriptedPeer, text, tools, use } from './kb-support.ts';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const parse = (raw: string, candidates: readonly { id: number }[] = [], clients: readonly string[] = ['acme']) => api.parseDecision(raw, candidates, clients);

test('strict decision parsing retains original response locally without adding model authority', () => {
  const raw = ` \n${JSON.stringify(decision())}\n `;
  expect(parse(raw)).toEqual({ ...decision(), raw });
  expect(parse(JSON.stringify(decision({ action: 'update', ticket: 17 })), [{ id: 17 }])).toMatchObject({ ticket: 17, action: 'update' });
  expect(parse(JSON.stringify(decision({ client: null })))).toMatchObject({ client: null });
});

test.each([
  { raw: 'forged evidence' }, { scope: { candidate_ids: [99] } }, { conversation_title: 'forged' }, { candidate_ids: [99] },
  { on_us: 'false' }, { confidence: '0.9' }, { confidence: -0.1 }, { confidence: 1.1 }, { confidence: null },
  { reason: '' }, { reason: null }, { action: 'approve' }, { action: 'update', ticket: null }, { action: 'new', ticket: 1 },
  { action: 'skip', on_us: true }, { on_us: false }, { title: ' ' }, { ticket: 0 }, { ticket: 1.5 }, { client: 'unknown' },
  { kb_notes: ['../outside.md'] }, { kb_notes: ['C:/outside.md'] }, { kb_notes: ['02_Areas/_secrets/keys.md'] },
  { kb_notes: ['.unison.merge/note.md'] }, { kb_notes: ['02_Areas/%2e%2e/note.md'] }, { kb_notes: 'note.md' },
])('rejects unknown fields, forged scope, invalid fields and unsafe KB paths: %j', (overrides) => {
  expect(() => parse(JSON.stringify(decision(overrides)), [{ id: 1 }])).toThrow();
});

test.each(Object.keys(decision()))('requires exact named model field %s', (key) => {
  const fields = decision() as Record<string, unknown>;
  delete fields[key];
  expect(() => parse(JSON.stringify(fields))).toThrow();
});

test.each([
  '```json\n{"on_us":true}\n```', 'Here is the decision: {}', '{}{}', '[]', 'null', 'true',
  `${JSON.stringify(decision())}\n${JSON.stringify(decision())}`, JSON.stringify(decision()).replace('0.9', '1e999'),
])('never salvages prose, fences, concatenated JSON or non-finite numbers: %s', (raw) => {
  expect(() => parse(raw)).toThrow();
});

test('candidate validation uses only offered ids and does not coerce strings', () => {
  expect(() => parse(JSON.stringify(decision({ action: 'update', ticket: 99 })), [{ id: 17 }])).toThrow(/candidate/i);
  expect(() => parse(JSON.stringify(decision({ action: 'update', ticket: '17' })), [{ id: 17 }])).toThrow();
  expect(parse(JSON.stringify(decision({ on_us: false, action: 'skip', ticket: null, title: '' })))).toMatchObject({ action: 'skip', on_us: false });
});

const run = api.assess;

test('configured vault guide reaches the triage system prompt and an empty guide adds nothing', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  await using peer = await scriptedPeer(() => ({ body: text(JSON.stringify(decision())) }));
  await run(cfg, context(), [], 'new', undefined, { db, providers: { first: provider(peer.baseURL) } });
  cfg.vault.guide = '01_Projects/<slug>.md holds one page per client engagement.';
  await run(cfg, context(), [], 'new', undefined, { db, providers: { first: provider(peer.baseURL) } });
  expect(peer.requests[0]!.system).not.toContain('Vault layout');
  expect(peer.requests[1]!.system).toContain("Vault layout, from Antonio's configuration (trusted): 01_Projects/<slug>.md holds one page per client engagement.");
});

test('the triage system prompt spells out every valid action, on_us and ticket combination', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  await using peer = await scriptedPeer(() => ({ body: text(JSON.stringify(decision())) }));
  await run(cfg, context(), [], 'new', undefined, { db, providers: { first: provider(peer.baseURL) } });
  const system = peer.requests[0]!.system;
  expect(system).toContain('skip: on_us false, ticket null');
  expect(system).toContain('new: on_us true, ticket null, non-empty title');
  expect(system).toContain('update: on_us true, ticket set to an offered candidate id, non-empty title');
  expect(system).toMatch(/already tracked.*skip/i);
  expect(system).toMatch(/mode is update.*different request.*is new/is);
  expect(system).toMatch(/mentions_me true tags Antonio.*never skip/is);
});

test('the triage prompt asks for a short sum-up and keeps evidence in the reason', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  await using peer = await scriptedPeer(() => ({ body: text(JSON.stringify(decision())) }));
  await run(cfg, context(), [], 'new', undefined, { db, providers: { first: provider(peer.baseURL) } });
  const system = peer.requests[0]!.system;
  expect(system).toContain('summary: a quick sum-up');
  expect(system).toMatch(/evidence.*belong in reason/i);
  const schema = JSON.parse(system.slice(system.indexOf('{"$schema"'), system.lastIndexOf('}') + 1));
  expect(schema.properties.summary.description).toMatch(/two short sentences/);
  expect(schema.properties.ask.description).toMatch(/one sentence/);
});

test('real HTTP peer searches, reads and returns strict JSON with matching tool ids and only two tools', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  const note = '02_Areas/workflows/deploy.md';
  await using peer = await scriptedPeer((_request, index) => ({ body: index === 0 ? tools(use('search-1')) : index === 1
    ? tools(use('read-1', 'vault_read', { path: note })) : text(JSON.stringify(decision({ kb_notes: [note] }))) }));
  expect(await run(cfg, context(), [], 'new', undefined, { db, providers: { first: provider(peer.baseURL) } })).toMatchObject({ kb_notes: [note] });
  expect(peer.requests).toHaveLength(3);
  expect(peer.errors).toEqual([]);
  expect(peer.paths).toEqual(['/v1/messages', '/v1/messages', '/v1/messages']);
  for (const request of peer.requests) {
    expect(request.tools.map((tool) => tool.name)).toEqual(['vault_search', 'vault_read']);
    expect(request.tools.every((tool) => tool.input_schema.additionalProperties === false)).toBe(true);
    expect(request.system).toMatch(/untrusted/i);
    expect(request.system).not.toContain('Synthetic source:');
  }
  const searchResult = peer.requests[1]!.messages.at(-1)!.content;
  expect(searchResult).toMatchObject([{ type: 'tool_result', tool_use_id: 'search-1' }]);
  expect(JSON.stringify(searchResult)).toContain(note);
  const readResult = peer.requests[2]!.messages.at(-1)!.content;
  expect(readResult).toMatchObject([{ type: 'tool_result', tool_use_id: 'read-1' }]);
  expect(JSON.stringify(readResult)).toContain('marker-417');
  expect(peer.headers[0]).toMatchObject({ 'x-api-key': 'synthetic-key', 'x-synthetic': 'fixture', 'anthropic-version': '2023-06-01' });
});

test.each([
  ['shell', { command: 'must never run' }], ['vault_search', { query: 'marker', root: 'C:/outside' }],
  ['vault_search', { query: ['marker'] }], ['vault_search', { query: 'marker', limit: 51 }],
  ['vault_search', { query: '   ' }],
  ['vault_read', { path: '../outside.md' }], ['vault_read', { path: '02_Areas/_secrets/keys.md' }],
  ['vault_read', { path: '02_Areas/workflows/deploy.md' }], ['vault_read', { path: 17 }],
] as const)('tool errors are bounded data, never outside operations: %s %j', async (name, input) => {
  const { cfg } = kbFixture();
  await using peer = await scriptedPeer((_request, index) => ({ body: index === 0 ? tools(use('invalid-tool', name, input)) : text() }));
  expect(await run(cfg, context(), [], 'new', undefined, { providers: { first: provider(peer.baseURL) } })).toMatchObject({ action: 'new' });
  expect(peer.requests).toHaveLength(2);
  expect(peer.requests[1]!.messages.at(-1)!.content).toMatchObject([{ type: 'tool_result', tool_use_id: 'invalid-tool', is_error: true }]);
  expect(JSON.stringify(peer.requests[1]!.messages.at(-1))).not.toContain('KB says');
});

test.each(['duplicate', 'replayed', 'empty'])('rejects %s tool-use ids without forged results', async (kind) => {
  const { cfg } = kbFixture();
  await using peer = await scriptedPeer((_request, index) => ({ body: kind === 'duplicate' ? tools(use('same'), use('same'))
    : tools(use(kind === 'empty' ? '' : index ? 'first-id' : 'first-id')) }));
  const error = await run(cfg, context(), [], 'new', undefined, { providers: { first: provider(peer.baseURL) } }).catch((error: unknown) => error);
  expect(error).toMatchObject({ type: 'model.invalid-decision', repaired: true });
  expect(String(error)).toMatch(/id/i);
  expect(peer.requests).toHaveLength(kind === 'replayed' ? 2 : 1);
});

test.each([9, 8])('global eight-call limit refuses %s-call overrun before executing the rejected batch', async (count) => {
  const { cfg } = kbFixture();
  const scanned = vi.spyOn(fs, 'opendirSync');
  await using peer = await scriptedPeer((_request, index) => ({ body: index === 0
    ? tools(...Array.from({ length: count }, (_, n) => use(`tool-${n}`))) : tools(use('ninth')) }));
  const error = await run(cfg, context(), [], 'new', undefined, { providers: { first: provider(peer.baseURL) } }).catch((error: unknown) => error);
  expect(error).toMatchObject({ type: 'model.invalid-decision', repaired: true });
  expect(String(error)).toMatch(/tool.*budget|call.*limit/i);
  expect(peer.requests).toHaveLength(count === 9 ? 1 : 2);
  expect(scanned.mock.calls.length).toBe(count === 9 ? 0 : 8 * 3);
});

test('repair receives the exact parse error once; another invalid answer retains both raw responses', async () => {
  const { cfg } = kbFixture();
  const first = '{"on_us":"false"}';
  const second = 'Still not JSON';
  let expected = '';
  try { api.parseDecision(first, [], ['acme']); } catch (error) { expected = (error as api.InvalidDecision).parse_error; }
  await using peer = await scriptedPeer((_request, index) => ({ body: text(index ? second : first) }));
  const error = await run(cfg, context(), [], 'new', undefined, { providers: { first: provider(peer.baseURL) } }).catch((error: unknown) => error);
  expect(error).toMatchObject({ type: 'model.invalid-decision', repaired: true, raw: second });
  expect(classify(error).error_class).toBe('job');
  expect(peer.requests).toHaveLength(2);
  const repair = peer.requests[1]!.messages.filter((message) => typeof message.content === 'string')
    .map((message) => JSON.parse(message.content as string) as Record<string, unknown>).find((message) => message.kind === 'decision_repair');
  expect(repair).toMatchObject({ parse_error: expected, raw: first });
  expect(error).toMatchObject({ responses: [{ raw: first, parse_error: expected }, { raw: second }] });
});

test('empty/text-only model errors cannot create a hidden unlimited retry loop', async () => {
  const { cfg } = kbFixture();
  await using peer = await scriptedPeer(() => ({ body: { content: [], stop_reason: 'end_turn' } }));
  const error = await run(cfg, context(), [], 'new', undefined, { providers: { first: provider(peer.baseURL) } }).catch((error: unknown) => error);
  expect(error).toMatchObject({ type: 'model.invalid-decision', repaired: true });
  expect(peer.requests).toHaveLength(2);
});

test('failed route stays unhealthy and cooling after fallback succeeds, including the next assessment', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['first', 'second'];
  using db = openDb(cfg.db.path);
  await using first = await scriptedPeer(() => ({ status: 429, headers: { 'retry-after': '60' }, body: { error: 'Synthetic busy' } }));
  await using second = await scriptedPeer(() => ({ body: text() }));
  const options = { db, providers: { first: provider(first.baseURL), second: provider(second.baseURL) } };
  expect(await run(cfg, context(), [], 'new', undefined, options)).toMatchObject({ on_us: true });
  expect(await run(cfg, context(), [], 'new', undefined, options)).toMatchObject({ on_us: true });
  expect(first.requests).toHaveLength(1);
  expect(second.requests).toHaveLength(2);
  const health = db.prepare("SELECT state,detail,last_error FROM health WHERE dependency='provider:first'").get()!;
  expect(health.state).toBe('retrying');
  expect(health.last_error).toMatch(/429/);
  expect(JSON.parse(String(health.detail))).toMatchObject({ consecutive_errors: 1 });
  expect(Date.parse(JSON.parse(String(health.detail)).retry_at) - Date.now()).toBeGreaterThan(55_000);
  expect(db.prepare("SELECT state FROM health WHERE dependency='provider:second'").get()?.state).toBe('ok');
});

test.each([400, 403, 401, 418])('HTTP %s never falls back because it is not a dependency error', async (status) => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['first', 'second'];
  await using first = await scriptedPeer(() => ({ status, body: { error: 'Synthetic error' } }));
  await using second = await scriptedPeer(() => ({ body: text() }));
  const error = await run(cfg, context(), [], 'new', undefined, { providers: { first: provider(first.baseURL), second: provider(second.baseURL) } }).catch((error: unknown) => error);
  expect(error).toMatchObject({ status });
  expect(first.requests).toHaveLength(1);
  expect(second.requests).toHaveLength(0);
});

test('all failed or cooling routes return the earliest retry floor, with no new requests during cooldown', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['first', 'second'];
  using db = openDb(cfg.db.path);
  const now = Date.parse('2026-11-06T00:00:00Z');
  await using first = await scriptedPeer(() => ({ status: 429, headers: { 'retry-after': '120' } }));
  await using second = await scriptedPeer(() => ({ status: 503, headers: { 'retry-after': '30' } }));
  const options = { db, now: () => now, providers: { first: provider(first.baseURL), second: provider(second.baseURL) } };
  for (let n = 0; n < 2; n++) {
    const error = await run(cfg, context(), [], 'new', undefined, options).catch((error: unknown) => error);
    expect(classify(error)).toMatchObject({ error_class: 'dependency', retry_after: 30 });
  }
  expect(first.requests).toHaveLength(1);
  expect(second.requests).toHaveLength(1);
});

test('fallback and repair share one tool-call budget rather than resetting it', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['first', 'second'];
  await using first = await scriptedPeer((_request, index) => index === 0
    ? { body: tools(...Array.from({ length: 5 }, (_, n) => use(`first-${n}`))) } : { status: 503 });
  await using second = await scriptedPeer((_request, index) => ({ body: index === 0 ? text('bad JSON') : index === 1
    ? tools(...Array.from({ length: 3 }, (_, n) => use(`repair-${n}`))) : tools(use('overrun')) }));
  const error = await run(cfg, context(), [], 'new', undefined, { providers: { first: provider(first.baseURL), second: provider(second.baseURL) } }).catch((error: unknown) => error);
  expect(error).toMatchObject({ type: 'model.invalid-decision', repaired: true });
  expect(String(error)).toMatch(/tool.*budget|call.*limit/i);
  expect(first.requests).toHaveLength(2);
  expect(second.requests).toHaveLength(3);
});

test('each fetch gets only the remaining wall budget across fallback and repair', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['first', 'second'];
  let now = Date.parse('2026-11-06T00:00:00Z');
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const signals: AbortSignal[] = [];
  let index = 0;
  const transport: typeof fetch = async (_input, init) => {
    signals.push(init!.signal!);
    const current = index++;
    now += current === 0 ? 45_000 : current === 1 ? 30_000 : 10_000;
    return new Response(JSON.stringify(current === 0 ? {} : current === 1 ? text('invalid') : text()), { status: current === 0 ? 503 : 200 });
  };
  expect(await run(cfg, context(), [], 'new', undefined, { fetch: transport, now: () => now, providers: { first: provider('http://first.invalid'), second: provider('http://second.invalid') } })).toMatchObject({ action: 'new' });
  expect(signals).toHaveLength(3);
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  expect(timers.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([120_000, 75_000, 45_000]));
});

test('a late response cannot escape the 120-second deadline', async () => {
  const { cfg } = kbFixture();
  let now = Date.now();
  const transport: typeof fetch = async () => { now += 120_001; return new Response(JSON.stringify(text())); };
  const error = await run(cfg, context(), [], 'new', undefined, { fetch: transport, now: () => now, providers: { first: provider('http://synthetic.invalid') } }).catch((error: unknown) => error);
  expect(error).toMatchObject({ name: 'TimeoutError' });
  expect(classify(error).error_class).toBe('dependency');
});

test.each(['timeout', 'external'])('%s abort is classified without a fallback or hidden model retry', async (kind) => {
  const { cfg } = kbFixture();
  cfg.triage.timeout_seconds = 1;
  cfg.triage.providers = ['first', 'second'];
  using db = openDb(cfg.db.path);
  vi.useFakeTimers();
  const controller = new AbortController();
  let calls = 0;
  const transport: typeof fetch = async (_input, init) => {
    calls++;
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  };
  const result = run(cfg, context(), [], 'new', controller.signal, { db, fetch: transport, providers: { first: provider('http://first.invalid'), second: provider('http://second.invalid') } }).catch((error: unknown) => error);
  if (kind === 'external') controller.abort(new Error('Worker stopping'));
  else await vi.advanceTimersByTimeAsync(1_000);
  const error = await result;
  expect(error).toMatchObject({ name: kind === 'external' ? 'AbortError' : 'TimeoutError' });
  expect(classify(error).error_class).toBe('dependency');
  expect(calls).toBe(1);
  if (kind === 'external') expect(db.prepare('SELECT COUNT(*) AS n FROM health').get()?.n).toBe(0);
});

test('duplicate JSON keys are rejected instead of accepting a last-value coercion bypass', () => {
  const raw = JSON.stringify(decision()).replace('"on_us":true', '"on_us":"false","on_us":true');
  expect(() => parse(raw)).toThrow(/duplicate/i);
});

test('HTTP dependency classification survives an oversized error body', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['first', 'second'];
  await using first = await scriptedPeer(() => ({ status: 503, body: 'x'.repeat(262_145) }));
  await using second = await scriptedPeer(() => ({ body: text() }));
  expect(await run(cfg, context(), [], 'new', undefined, { providers: { first: provider(first.baseURL), second: provider(second.baseURL) } })).toMatchObject({ action: 'new' });
  expect(first.requests).toHaveLength(1);
  expect(second.requests).toHaveLength(1);
});

test('production route loading uses an explicit synthetic JSONC file, never global provider state', async () => {
  const { cfg, root } = kbFixture();
  await using peer = await scriptedPeer(() => ({ body: text() }));
  const providerConfigPath = join(root, 'providers.jsonc');
  fs.writeFileSync(providerConfigPath, `// synthetic fixture\n${JSON.stringify({ providers: { first: provider(peer.baseURL) } })}`);
  expect(await run(cfg, context(), [], 'new', undefined, { providerConfigPath })).toMatchObject({ action: 'new' });
  expect(peer.requests).toHaveLength(1);
});

test('a late nondependency HTTP response cannot override the global deadline', async () => {
  const { cfg } = kbFixture();
  let now = Date.now();
  const transport: typeof fetch = async () => { now += 120_001; return new Response('{}', { status: 400 }); };
  const error = await run(cfg, context(), [], 'new', undefined, { fetch: transport, now: () => now, providers: { first: provider('http://synthetic.invalid') } }).catch((error: unknown) => error);
  expect(error).toMatchObject({ name: 'TimeoutError' });
  expect(classify(error).error_class).toBe('dependency');
});

test('a local health statement failure is not attributed to the provider or retried through another route', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['first', 'second'];
  using db = openDb(cfg.db.path);
  const prepare = db.prepare.bind(db);
  let injected = false;
  vi.spyOn(db, 'prepare').mockImplementation((sql, options) => {
    if (!injected && sql.includes('INSERT INTO health(dependency,state,since,last_ok')) {
      injected = true;
      throw Object.assign(new Error('Synthetic local health busy'), { code: 'SQLITE_BUSY' });
    }
    return prepare(sql, options);
  });
  await using first = await scriptedPeer(() => ({ body: text() }));
  await using second = await scriptedPeer(() => ({ body: text() }));
  const error = await run(cfg, context(), [], 'new', undefined, { db, providers: { first: provider(first.baseURL), second: provider(second.baseURL) } }).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'SQLITE_BUSY', message: 'Synthetic local health busy' });
  expect(first.requests).toHaveLength(1);
  expect(second.requests).toHaveLength(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM health').get()?.n).toBe(0);
});

test.each(['fallback', 'repair'])('%s starts a fresh tool-id transcript and returns matching reused ids', async (boundary) => {
  const { cfg } = kbFixture();
  if (boundary === 'fallback') cfg.triage.providers = ['first', 'second'];
  using db = openDb(cfg.db.path);
  await using peer = await scriptedPeer((_request, index) => index === 0 || index === 2 ? { body: tools(use('call_1')) }
    : index === 1 ? boundary === 'fallback' ? { status: 503 } : { body: text('invalid initial decision') } : { body: text() });
  const result = await run(cfg, context(), [], 'new', undefined, { db, providers: { first: provider(peer.baseURL), second: provider(peer.baseURL) } }).catch((error: unknown) => error);
  expect(result).toMatchObject({ action: 'new' });
  expect(peer.requests).toHaveLength(4);
  expect(peer.errors).toEqual([]);
  for (const index of [1, 3]) expect(peer.requests[index]!.messages.at(-1)!.content).toMatchObject([{ type: 'tool_result', tool_use_id: 'call_1' }]);
  expect(peer.requests[2]!.messages).toHaveLength(boundary === 'fallback' ? 1 : 2);
  expect(JSON.stringify(peer.requests[2]!.messages)).not.toContain('tool_result');
  if (boundary === 'fallback') {
    const health = db.prepare("SELECT state,detail,last_error FROM health WHERE dependency='provider:first'").get()!;
    expect(health).toMatchObject({ state: 'retrying', last_error: 'Provider first HTTP 503' });
    expect(JSON.parse(String(health.detail))).toMatchObject({ consecutive_errors: 1, retry_at: expect.any(String) });
    expect(db.prepare("SELECT state FROM health WHERE dependency='provider:second'").get()?.state).toBe('ok');
  }
});

test.each(['fallback', 'repair'])('%s clears replay ids without resetting the global eight-call budget', async (boundary) => {
  const { cfg } = kbFixture();
  if (boundary === 'fallback') cfg.triage.providers = ['first', 'second'];
  const scanned = vi.spyOn(fs, 'opendirSync');
  await using peer = await scriptedPeer((_request, index) => index === 0
    ? { body: tools(...Array.from({ length: 6 }, (_, n) => use(`call_${n + 1}`))) }
    : index === 1 ? boundary === 'fallback' ? { status: 503 } : { body: text('invalid initial decision') }
      : index === 2 ? { body: tools(use('call_1'), use('call_2')) } : index === 3 ? { body: tools(use('call_3')) } : { body: text() });
  const result = await run(cfg, context(), [], 'new', undefined, { providers: { first: provider(peer.baseURL), second: provider(peer.baseURL) } }).catch((error: unknown) => error);
  expect(result).toMatchObject({ type: 'model.invalid-decision', repaired: true, parse_error: 'Tool call budget exhausted; batch refused' });
  expect(peer.requests).toHaveLength(4);
  expect(peer.requests[1]!.messages.at(-1)!.content).toHaveLength(6);
  expect(peer.requests[3]!.messages.at(-1)!.content).toMatchObject([{ tool_use_id: 'call_1' }, { tool_use_id: 'call_2' }]);
  expect(scanned.mock.calls).toHaveLength(8 * 3);
});

test.each(['fallback', 'repair'])('%s reused ids retain remaining-duration signals from the original deadline', async (boundary) => {
  const { cfg } = kbFixture();
  if (boundary === 'fallback') cfg.triage.providers = ['first', 'second'];
  let now = Date.parse('2026-11-06T00:00:00Z');
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const signals: AbortSignal[] = [];
  let calls = 0;
  const transport: typeof fetch = async (_input, init) => {
    signals.push(init!.signal!);
    const index = calls++;
    now += [20_000, 30_000, 10_000, 5_000][index]!;
    const body = index === 0 || index === 2 ? tools(use('call_1')) : index === 1 ? text('invalid initial decision') : text();
    return new Response(JSON.stringify(body), { status: index === 1 && boundary === 'fallback' ? 503 : 200 });
  };
  const result = await run(cfg, context(), [], 'new', undefined, { fetch: transport, now: () => now,
    providers: { first: provider('http://first.invalid'), second: provider('http://second.invalid') } }).catch((error: unknown) => error);
  expect(result).toMatchObject({ action: 'new' });
  expect(signals).toHaveLength(4);
  expect(new Set(signals).size).toBe(4);
  expect(timers.mock.calls.map((call) => call[1])).toEqual([120_000, 100_000, 70_000, 60_000]);
});

test('a reused fallback id does not grant a second repair after the first route already used it', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['first', 'second'];
  await using peer = await scriptedPeer((_request, index) => index === 0 ? { body: text('first invalid decision') }
    : index === 1 || index === 3 ? { body: tools(use('call_1')) } : index === 2 ? { status: 503 } : { body: text('last invalid decision') });
  const result = await run(cfg, context(), [], 'new', undefined, { providers: { first: provider(peer.baseURL), second: provider(peer.baseURL) } }).catch((error: unknown) => error);
  expect(result).toMatchObject({ type: 'model.invalid-decision', repaired: true, raw: 'last invalid decision',
    responses: [{ raw: 'first invalid decision' }, { raw: 'last invalid decision' }] });
  expect(peer.requests).toHaveLength(5);
  expect(peer.requests[4]!.messages.at(-1)!.content).toMatchObject([{ type: 'tool_result', tool_use_id: 'call_1' }]);
});
