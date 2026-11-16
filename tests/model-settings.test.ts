import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as chat from '../src/core/chat.ts';
import { openDb } from '../src/core/db.ts';
import { handleTriage } from '../src/core/kb-agent.ts';
import { modelOptions } from '../src/core/runtime.ts';
import { modelChoice, readModelOptions, requestModelOptions, saveSetting, storeModelOptions, takeModelRequest } from '../src/core/settings.ts';
import { ingest, schedule } from '../src/core/ingest.ts';
import * as jobs from '../src/core/jobs.ts';
import { TicketError } from '../src/core/tickets.ts';
import { readState } from '../src/web/state.ts';
import { AT, addBatch, chatFixture, claimed, proposed } from './chat-support.ts';
import { decision, kbFixture, provider, scriptedPeer as triagePeer, text } from './kb-support.ts';
import { scriptedPeer } from './opencode-support.ts';

beforeEach(() => { vi.stubEnv('EVERFLOW_OPENCODE_PASSWORD', ''); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT)); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

test('a page choice overrides the config model and effort; an empty value goes back to the default; bad values are refused', () => {
  const { cfg } = kbFixture();
  cfg.opencode.model = 'meridian-auto/claude-opus-5-5';
  using db = openDb(cfg.db.path);
  expect(modelChoice(db, cfg, 'chat')).toEqual({ model: 'meridian-auto/claude-opus-5-5', effort: null, default_model: 'meridian-auto/claude-opus-5-5', overridden: false });
  saveSetting(db, 'chat.model', 'meridian-notarify/claude-sonnet-5-5');
  saveSetting(db, 'chat.effort', 'xhigh');
  saveSetting(db, 'triage.effort', 'low');
  expect(modelChoice(db, cfg, 'chat')).toMatchObject({ model: 'meridian-notarify/claude-sonnet-5-5', effort: 'xhigh', overridden: true });
  expect(modelChoice(db, cfg, 'triage')).toMatchObject({ model: `first/${cfg.triage.model}`, effort: 'low', overridden: true });
  saveSetting(db, 'chat.model', ' ');
  expect(modelChoice(db, cfg, 'chat').model).toBe('meridian-auto/claude-opus-5-5');
  saveSetting(db, 'chat.effort', 'none');
  expect(modelChoice(db, cfg, 'chat').effort).toBe('none');
  for (const [key, value] of [['triage.effort', 'none'], ['chat.effort', 'Bad Value'], ['chat.model', 'no-provider'], ['triage.model', 'a/b/c'], ['triage.account', 'second'], ['other.key', 'x']] as const) {
    expect(() => saveSetting(db, key, value)).toThrow(TicketError);
  }
});

test('the next triage call sends the chosen model and effort to the provider', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  saveSetting(db, 'triage.model', 'claude-sonnet-5-5');
  saveSetting(db, 'triage.effort', 'high');
  ingest(db, { source: 'outlook', account: 'me@acme.invalid', conversation_id: 'conversation', conversation_title: 'Title', message_id: 'native-1',
    sender: 'bob@acme.invalid', sender_name: 'Bob', sender_is_me: false, sent_at: '2026-11-05T23:50:00Z', text: 'Check RCA-12' });
  schedule(db, cfg, AT);
  await using peer = await triagePeer(() => ({ body: text(JSON.stringify(decision())) }));
  await handleTriage(cfg, db, jobs.claim(db, cfg, 'w', AT)!, { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests[0]).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'high' } });
  saveSetting(db, 'triage.effort', '');
  expect(modelChoice(db, cfg, 'triage').effort).toBeNull();
});

test('a triage model picked on an account tries that account first and fails over to the others; an account no longer configured counts as no choice', async () => {
  const { cfg } = kbFixture();
  cfg.triage.providers = ['first', 'second'];
  using db = openDb(cfg.db.path);
  saveSetting(db, 'triage.model', 'gone/claude-opus-5-5');
  expect(modelChoice(db, cfg, 'triage')).toMatchObject({ model: 'first/synthetic-small', overridden: false });
  saveSetting(db, 'triage.model', 'second/claude-opus-5-5');
  expect(modelChoice(db, cfg, 'triage')).toMatchObject({ model: 'second/claude-opus-5-5', default_model: 'first/synthetic-small', overridden: true });
  ingest(db, { source: 'outlook', account: 'me@acme.invalid', conversation_id: 'conversation', conversation_title: 'Title', message_id: 'native-1',
    sender: 'bob@acme.invalid', sender_name: 'Bob', sender_is_me: false, sent_at: '2026-11-05T23:50:00Z', text: 'Check RCA-12' });
  schedule(db, cfg, AT);
  await using first = await triagePeer(() => ({ body: text(JSON.stringify(decision())) }));
  await using second = await triagePeer(() => ({ status: 429, headers: { 'retry-after': '60' }, body: {} }));
  await handleTriage(cfg, db, jobs.claim(db, cfg, 'w', AT)!, { providers: { first: provider(first.baseURL), second: provider(second.baseURL) } });
  expect([second.requests.map((request) => request.model), first.requests.map((request) => request.model)]).toEqual([['claude-opus-5-5'], ['claude-opus-5-5']]);
});


async function createdModel(settings: [string, string][]) {
  await using peer = await scriptedPeer();
  const { cfg, path } = chatFixture(peer.url);
  cfg.opencode.model = 'meridian-auto/claude-opus-5-5';
  using db = openDb(path);
  for (const [key, value] of settings) saveSetting(db, key, value);
  const ticket = proposed(db);
  addBatch(db, ticket);
  chat.approve(cfg, db, ticket, '');
  await chat.startChat(cfg, db, claimed(db, cfg));
  return peer.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session').map((call) => call.body.model);
}

test('a new ticket chat starts on the chosen model and effort; without a choice it sends the config model and no variant', async () => {
  expect(await createdModel([])).toEqual([{ providerID: 'meridian-auto', id: 'claude-opus-5-5' }]);
  expect(await createdModel([['chat.model', 'meridian-roar/claude-sonnet-5-5'], ['chat.effort', 'max']]))
    .toEqual([{ providerID: 'meridian-roar', id: 'claude-sonnet-5-5', variant: 'max' }]);
});

test('picker options are fetched only on request, keep the side that worked and show in the page state', async () => {
  const { cfg } = kbFixture();
  using db = openDb(cfg.db.path);
  expect(takeModelRequest(db)).toBe(false);
  requestModelOptions(db);
  expect(readState(db, cfg).models.options.requested_at).not.toBeNull();
  expect(takeModelRequest(db)).toBe(true);
  expect(takeModelRequest(db)).toBe(false);
  const models = async () => [
    { providerID: 'meridian-auto', modelID: 'claude-opus-5-5', name: 'Opus auto', enabled: true, status: 'active', variants: [{ id: 'high' }, { id: 'max' }] },
    { providerID: 'old', modelID: 'gone', name: 'Old', enabled: true, status: 'deprecated', variants: [] },
  ];
  const peer = { models, providers: async () => [{ id: 'meridian-auto', name: 'Claude auto (pool)' }, { id: 'first', name: 'Claude #1 (first)' }] } as never;
  const value = await modelOptions(cfg, peer);
  expect(value.chat).toEqual([{ id: 'meridian-auto/claude-opus-5-5', name: 'Opus auto', efforts: ['high', 'max'] }]);
  expect(value.accounts).toEqual({ 'meridian-auto': 'Claude auto (pool)', first: 'Claude #1 (first)' });
  expect(value.error).toBeNull();
  const noNames = await modelOptions(cfg, { models, providers: async () => { throw new Error('down'); } } as never);
  expect([noNames.chat.length, noNames.accounts, noNames.error]).toEqual([1, {}, null]);
  const noModels = await modelOptions(cfg, { models: async () => { throw new Error('OpenCode HTTP 503'); }, providers: async () => [] } as never);
  expect([noModels.chat, noModels.error]).toEqual([[], 'Model list: OpenCode HTTP 503']);
  // A failed list is fetched again a minute later with no page asking; a good one waits for a request
  storeModelOptions(db, { ...noModels, at: AT });
  const later = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString();
  expect([takeModelRequest(db, later(30)), takeModelRequest(db, later(61))]).toEqual([false, true]);
  storeModelOptions(db, { ...value, at: AT });
  expect(takeModelRequest(db, later(3600))).toBe(false);
  storeModelOptions(db, value);
  expect(readState(db, cfg).models.options).toMatchObject({ chat: value.chat, accounts: value.accounts, at: value.at, error: value.error, requested_at: null });
  expect(readState(db, cfg).models.triage_routes).toEqual(cfg.triage.providers);
  // Lists stored before account names count as stale, so the page asks again
  const { accounts: _, ...older } = value;
  storeModelOptions(db, older as never);
  expect(readState(db, cfg).models.options).toMatchObject({ accounts: {}, at: null });
});
