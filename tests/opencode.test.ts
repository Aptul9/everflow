import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SessionMessageInfo } from '@opencode/client';
import { loadConfig } from '../src/dispatcher/config.ts';
import * as transport from '../src/dispatcher/opencode.ts';
import { classify } from '../src/dispatcher/jobs.ts';
import { remoteSession, scriptedPeer, PEER_AT } from './opencode-support.ts';
import { scratch } from './support.ts';

beforeEach(() => vi.stubEnv('INBOX_OPENCODE_PASSWORD', ''));
afterEach(() => vi.unstubAllEnvs());

function config(url: string) {
  const files = scratch('phase5-transport-');
  const cfg = loadConfig(files.config);
  cfg.opencode.url = url;
  return { cfg, files };
}

test('uses the typed client and omits permissions while persisting a store/ticket tag', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config(peer.url);
  cfg.opencode.model = 'synthetic-provider/model/with/slash';
  const api = transport.connect(cfg);
  const session = await api.create('Working: Synthetic', 'store-one', 7);
  const call = peer.calls.find((call) => call.method === 'POST')!;
  expect(call.body).not.toHaveProperty('permissions');
  expect(call.body).toMatchObject({ location: { directory: cfg.opencode.directory }, model: { providerID: 'synthetic-provider', id: 'model/with/slash' },
    metadata: { inbox_dispatcher: { store_id: 'store-one', ticket: 7 } } });
  expect(await api.findTicket('store-one', 7)).toBe(session.id);
  expect(await api.findTicket('another-store', 7)).toBeNull();
  expect(await api.get(session.id)).toMatchObject({ id: session.id });
});

test('OC_AUTH_COOKIE signs in at current settings path without persisting credentials', async () => {
  await using peer = await scriptedPeer();
  const { cfg, files } = config('');
  const settings = `${files.root}/settings.json`;
  writeFileSync(settings, JSON.stringify({ desktopLocalPort: Number(new URL(peer.url).port), desktopUiPassword: 'synthetic-secret' }));
  peer.state.hook = (call, response) => {
    if (call.url.pathname === '/auth/session') {
      expect(call.body).toEqual({ password: 'synthetic-secret' });
      response.writeHead(200, { 'set-cookie': 'oc_session=synthetic-cookie; HttpOnly; Path=/' }); response.end('{}'); return true;
    }
    if (call.cookie !== 'oc_session=synthetic-cookie') { peer.json(response, {}, 401); return true; }
    return false;
  };
  const api = transport.connect(cfg, { settingsPath: settings });
  expect(peer.calls).toHaveLength(0);
  await api.create('Synthetic', 'store', 1);
  expect(peer.calls.map((call) => call.url.pathname)).toEqual(['/auth/session', '/api/session']);
  expect(peer.calls[1]!.authorization).toBeUndefined();
});

test('OC_AUTH_RELOGIN retries exactly once after a fresh 401 and marks rejected fresh authentication', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config('');
  let logins = 0;
  peer.state.hook = (call, response) => {
    if (call.url.pathname === '/auth/session') {
      logins++;
      response.writeHead(200, { 'set-cookie': `oc_session=synthetic-${logins}; Path=/` }); response.end('{}'); return true;
    }
    peer.json(response, {}, 401); return true;
  };
  const api = transport.connect(cfg, { readSettings: () => ({ desktopLocalPort: Number(new URL(peer.url).port), desktopUiPassword: 'synthetic' }) });
  const error = await api.get('ses_1').catch((error: unknown) => error);
  expect(logins).toBe(2);
  expect(peer.calls.filter((call) => call.url.pathname === '/api/session/ses_1')).toHaveLength(2);
  expect(classify(error).error_class).toBe('job');
  expect(JSON.stringify(error)).not.toMatch(/synthetic-[12]|desktopUiPassword/);
});

test('OC_AUTH_RELOGIN refreshes expired cookie and succeeds without retrying a successful request', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config('');
  peer.sessions.set('ses_1', remoteSession('ses_1', cfg.opencode.directory));
  let logins = 0;
  peer.state.hook = (call, response) => {
    if (call.url.pathname === '/auth/session') {
      response.writeHead(200, { 'set-cookie': `oc_session=${++logins}; Path=/` }); response.end('{}'); return true;
    }
    if (call.cookie !== 'oc_session=2') { peer.json(response, {}, 401); return true; }
    return false;
  };
  const api = transport.connect(cfg, { readSettings: () => ({ desktopLocalPort: Number(new URL(peer.url).port), desktopUiPassword: 'synthetic' }) });
  expect((await api.get('ses_1')).id).toBe('ses_1');
  expect((await api.get('ses_1')).id).toBe('ses_1');
  expect(logins).toBe(2);
  expect(peer.calls.filter((call) => call.url.pathname === '/api/session/ses_1')).toHaveLength(3);
});

test('optional plain-server Basic auth has no cookie login', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config(peer.url);
  const api = transport.connect(cfg, { password: 'synthetic-basic' });
  await api.create('Synthetic', 'store', 1);
  expect(peer.calls).toHaveLength(1);
  expect(peer.calls[0]!.authorization).toBe(`Basic ${Buffer.from('opencode:synthetic-basic').toString('base64')}`);
  expect(peer.calls[0]!.cookie).toBeUndefined();
});

test('OC_AUTH_ORIGIN rejects cross-origin requests before forwarding credentials and disallows redirects', async () => {
  await using peer = await scriptedPeer();
  await using other = await scriptedPeer();
  const fetch = transport.authenticatedFetch({ url: peer.url, password: 'synthetic', openchamber: false, timeoutMs: 1000 });
  await expect(fetch(`${other.url}/api/session`)).rejects.toThrow(/origin/i);
  expect(other.calls).toHaveLength(0);
  peer.state.hook = (_call, response) => { response.writeHead(302, { location: `${other.url}/api/session` }); response.end(); return true; };
  await expect(fetch(`${peer.url}/api/session`)).rejects.toThrow();
  expect(other.calls).toHaveLength(0);
});

test('transport has an explicit timeout and propagates cancellation', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config(peer.url);
  peer.state.hook = () => true;
  const api = transport.connect(cfg, { timeoutMs: 20 });
  await expect(api.get('ses_1')).rejects.toMatchObject({ cause: { name: 'TimeoutError' } });
  const controller = new AbortController(); controller.abort();
  await expect(api.get('ses_1', controller.signal)).rejects.toMatchObject({ cause: { name: 'AbortError' } });
});

test('tag lookup scans every archived page, omits order with opaque cursors, rejects duplicates', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config(peer.url);
  const tagged = remoteSession('ses_tagged', cfg.opencode.directory, { inbox_dispatcher: { store_id: 'durable-store', ticket: 9 } });
  peer.state.hook = (call, response) => {
    if (call.url.pathname !== '/api/session') return false;
    const archived = call.url.searchParams.get('archived');
    const cursor = call.url.searchParams.get('cursor');
    if (archived === 'true' && cursor === 'opaque-next') peer.json(response, { data: [tagged], cursor: {} });
    else peer.json(response, { data: [], cursor: cursor ? {} : { next: 'opaque-next' } });
    return true;
  };
  const api = transport.connect(cfg);
  expect(await api.findTicket('durable-store', 9)).toBe('ses_tagged');
  expect(peer.calls).toHaveLength(4);
  for (const call of peer.calls) {
    expect(call.url.searchParams.get('directory')).toBe(cfg.opencode.directory);
    if (call.url.searchParams.has('cursor')) expect(call.url.searchParams.has('order')).toBe(false);
  }
  peer.state.hook = (call, response) => {
    peer.json(response, { data: call.url.searchParams.get('archived') === 'true' ? [tagged, { ...tagged, id: 'ses_duplicate' }] : [], cursor: {} }); return true;
  };
  await expect(api.findTicket('durable-store', 9)).rejects.toMatchObject({ type: 'opencode.duplicate-tag' });
  peer.state.hook = (_call, response) => { peer.json(response, {}, 503); return true; };
  expect(classify(await api.findTicket('durable-store', 9).catch((error: unknown) => error))).toMatchObject({ error_class: 'dependency' });
});

function user(id: string): SessionMessageInfo { return { id, type: 'user', text: 'Synthetic input', time: { created: PEER_AT } }; }
function answer(id: string, text: string, completed = true): SessionMessageInfo {
  return { id, type: 'assistant', time: { created: PEER_AT, ...(completed ? { completed: PEER_AT + 100 } : {}) },
    agent: 'build', model: { id: 'synthetic', providerID: 'synthetic' }, content: [{ type: 'text', text }] };
}

test('collects only completed text inside exact target interval across all pages, never later direct turns', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config(peer.url);
  peer.sessions.set('ses_1', remoteSession('ses_1', cfg.opencode.directory));
  peer.messages.set('ses_1', [user('msg_target'), answer('asst_old', 'Own answer\nSTATUS: waiting_them | Waiting'),
    { id: 'idle_old', type: 'idle', time: { created: PEER_AT + 101 }, outcome: 'succeeded' }, user('msg_later'),
    ...Array.from({ length: 55 }, (_, i) => answer(`asst_later_${i}`, 'Later direct secret\nSTATUS: done | Later')),
    { id: 'idle_later', type: 'idle', time: { created: PEER_AT + 999 }, outcome: 'failed', error: { type: 'provider.no-route', message: 'later failure' } }]);
  const api = transport.connect(cfg);
  expect(await api.turnDetail('ses_1', 'msg_target')).toMatchObject({ state: 'terminal', outcome: 'succeeded', error: null,
    text: 'Own answer\nSTATUS: waiting_them | Waiting', prompt_at: PEER_AT, assistant_id: 'asst_old', completed_at: PEER_AT + 100 });
  expect(peer.calls.filter((call) => call.url.pathname.endsWith('/message'))).toHaveLength(2);
  expect(peer.calls[1]!.url.searchParams.has('order')).toBe(false);
  peer.messages.set('ses_1', [user('msg_target'), answer('asst_partial', 'STATUS: done | Streaming', false)]);
  expect(await api.turnDetail('ses_1', 'msg_target')).toMatchObject({ state: 'running', text: '', outcome: null, assistant_id: null });
});

test('distinguishes inbox waiting, proven absent, running and structured terminal failure', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config(peer.url);
  peer.sessions.set('ses_1', remoteSession('ses_1', cfg.opencode.directory));
  const api = transport.connect(cfg);
  expect(await api.prompt('ses_1', 'msg_target', 'Exact text')).toBe('msg_target');
  expect(await api.turnDetail('ses_1', 'msg_target')).toMatchObject({ state: 'waiting' });
  expect(await api.turnDetail('ses_1', 'msg_missing')).toMatchObject({ state: 'absent' });
  peer.deliver('ses_1', 'msg_target');
  expect(await api.turnDetail('ses_1', 'msg_target')).toMatchObject({ state: 'running' });
  const error = { type: 'provider.request', message: 'synthetic quota', status: 429, retryAfterMs: 3600000, response: { body: 'synthetic-body' } };
  peer.finish('ses_1', 'msg_target', 'provider unavailable', 'failed', error, PEER_AT + 1000);
  expect(await api.turnDetail('ses_1', 'msg_target')).toMatchObject({ state: 'terminal', outcome: 'failed', error, assistant_id: 'asst_msg_target', completed_at: PEER_AT + 1000 });
  peer.state.historyStatus = 503;
  expect(classify(await api.turnDetail('ses_1', 'msg_missing').catch((error: unknown) => error))).toMatchObject({ error_class: 'dependency' });
});

test('latestReport returns the latest completed interval identity, not session title update time', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config(peer.url);
  peer.sessions.set('ses_1', remoteSession('ses_1', cfg.opencode.directory));
  peer.messages.set('ses_1', [user('msg_direct'), answer('asst_direct', 'STATUS: needs_you | Exact yes required'),
    { id: 'idle_direct', type: 'idle', time: { created: PEER_AT + 500 }, outcome: 'succeeded' }, user('msg_streaming'),
    answer('asst_streaming', 'STATUS: done | Incomplete', false)]);
  const api = transport.connect(cfg);
  await api.rename('ses_1', 'Needs you: Synthetic');
  expect(await api.latestReport('ses_1')).toMatchObject({ prompt_id: 'msg_direct', assistant_id: 'asst_direct', completed_at: PEER_AT + 100,
    text: 'STATUS: needs_you | Exact yes required', state: 'terminal', outcome: 'succeeded' });
  await api.archive('ses_1', true);
  expect((await api.get('ses_1')).time.archived).toBeTypeOf('number');
  await api.archive('ses_1', false);
  expect((await api.get('ses_1')).time.archived).toBeUndefined();
});

test('missing session is a structured job error rather than an unknown retry loop', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config(peer.url);
  const error = await transport.connect(cfg).get('ses_missing').catch((error: unknown) => error);
  expect(classify(error).error_class).toBe('job');
});

test('retains structured failed assistant error even when provider failed before assistant completion', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config(peer.url);
  peer.sessions.set('ses_1', remoteSession('ses_1', cfg.opencode.directory));
  const error = { type: 'provider.transport', message: 'synthetic unavailable', retryAfterMs: 1500 };
  const failed = answer('asst_failed', 'Incomplete provider text', false);
  if (failed.type !== 'assistant') throw new Error('Expected assistant fixture');
  failed.error = error;
  failed.finish = 'error';
  peer.messages.set('ses_1', [user('msg_target'), failed, { id: 'idle_failed', type: 'idle', outcome: 'failed', time: { created: PEER_AT + 500 } }]);
  expect(await transport.connect(cfg).turnDetail('ses_1', 'msg_target')).toMatchObject({ state: 'terminal', outcome: 'failed', text: '',
    error, assistant_id: 'asst_failed', completed_at: PEER_AT + 500 });
});

test('tag lookup treats Windows directory casing/separators as the same configured directory', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config(peer.url);
  const tagged = remoteSession('ses_normalized', cfg.opencode.directory.replaceAll('\\', '/').toUpperCase() + '/',
    { inbox_dispatcher: { store_id: 'store-normalized', ticket: 5 } });
  peer.state.hook = (_call, response) => { peer.json(response, { data: [tagged], cursor: {} }); return true; };
  expect(await transport.connect(cfg).findTicket('store-normalized', 5)).toBe('ses_normalized');
});

test('invalid auth settings never put credential-shaped file contents in errors', () => {
  const { cfg, files } = config('');
  const settings = `${files.root}/invalid-settings.json`;
  writeFileSync(settings, 'very-private-password-not-json');
  let error: unknown;
  try { transport.connect(cfg, { settingsPath: settings }); } catch (failure) { error = failure; }
  expect(error).toBeTruthy();
  expect(String(error)).not.toContain('very-private');
  expect(classify(error).error_class).toBe('job');
});

test('an older idle boundary cannot terminate newer streaming work or supply its report identity', async () => {
  await using peer = await scriptedPeer();
  const { cfg } = config(peer.url);
  peer.sessions.set('ses_1', remoteSession('ses_1', cfg.opencode.directory));
  const partial = answer('asst_new', 'STATUS: done | Still streaming', false);
  partial.time.created = PEER_AT + 1000;
  peer.messages.set('ses_1', [user('msg_target'), answer('asst_old', 'STATUS: working | Earlier output'),
    { id: 'idle_old', type: 'idle', outcome: 'succeeded', time: { created: PEER_AT + 101 } }, partial]);
  const api = transport.connect(cfg);
  expect(await api.turnDetail('ses_1', 'msg_target')).toMatchObject({ state: 'running', outcome: null, assistant_id: 'asst_old',
    completed_at: null, text: 'STATUS: working | Earlier output' });
  expect(await api.latestReport('ses_1')).toBeNull();
});
