import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as chat from '../src/dispatcher/chat.ts';
import { openDb } from '../src/dispatcher/db.ts';
import { handleTriage } from '../src/dispatcher/kb-agent.ts';
import { modelOptions } from '../src/dispatcher/runtime.ts';
import { modelChoice, readModelOptions, requestModelOptions, saveSetting, storeModelOptions, takeModelRequest } from '../src/dispatcher/settings.ts';
import { ingest, schedule } from '../src/dispatcher/ingest.ts';
import * as jobs from '../src/dispatcher/jobs.ts';
import { TicketError } from '../src/dispatcher/tickets.ts';
import { readState } from '../src/web/state.ts';
import { AT, addBatch, chatFixture, claimed, proposed } from './chat-support.ts';
import { decision, kbFixture, provider, scriptedPeer as triagePeer, text } from './kb-support.ts';
import { scriptedPeer } from './opencode-support.ts';

beforeEach(() => { vi.stubEnv('WORKDESK_OPENCODE_PASSWORD', ''); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT)); });
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
  expect(modelChoice(db, cfg, 'triage')).toMatchObject({ model: cfg.triage.model, effort: 'low', overridden: true });
  saveSetting(db, 'chat.model', ' ');
  expect(modelChoice(db, cfg, 'chat').model).toBe('meridian-auto/claude-opus-5-5');
  saveSetting(db, 'chat.effort', 'none');
  expect(modelChoice(db, cfg, 'chat').effort).toBe('none');
  for (const [key, value] of [['triage.effort', 'none'], ['chat.effort', 'Bad Value'], ['chat.model', 'no-provider'], ['triage.model', 'a/b'], ['other.key', 'x']] as const) {
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
  const { cfg, root } = kbFixture();
  cfg.triage.provider_config_path = join(root, 'providers.jsonc');
  writeFileSync(cfg.triage.provider_config_path, JSON.stringify({ providers: { first: provider('http://127.0.0.1:9/v1') } }));
  using db = openDb(cfg.db.path);
  expect(takeModelRequest(db)).toBe(false);
  requestModelOptions(db);
  expect(readState(db, cfg).models.options.requested_at).not.toBeNull();
  expect(takeModelRequest(db)).toBe(true);
  expect(takeModelRequest(db)).toBe(false);
  const peer = { models: async () => [
    { providerID: 'meridian-auto', modelID: 'claude-opus-5-5', name: 'Opus auto', enabled: true, status: 'active', variants: [{ id: 'high' }, { id: 'max' }] },
    { providerID: 'old', modelID: 'gone', name: 'Old', enabled: true, status: 'deprecated', variants: [] },
  ] } as never;
  const failing = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
  const value = await modelOptions(cfg, peer, failing);
  expect(value.chat).toEqual([{ id: 'meridian-auto/claude-opus-5-5', name: 'Opus auto', efforts: ['high', 'max'] }]);
  expect(value.triage).toEqual([]);
  expect(value.error).toBe('triage: Provider first HTTP 503');
  const served = (async () => Response.json({ data: [{ id: 'claude-haiku-5-5', display_name: 'Haiku', capabilities: { effort: { low: { supported: true }, max: { supported: false }, supported: true } } }] })) as unknown as typeof fetch;
  expect((await modelOptions(cfg, peer, served)).triage).toEqual([{ id: 'claude-haiku-5-5', name: 'Haiku', efforts: ['low'] }]);
  storeModelOptions(db, value);
  expect(readState(db, cfg).models.options).toMatchObject({ chat: value.chat, error: value.error, requested_at: null });
});
