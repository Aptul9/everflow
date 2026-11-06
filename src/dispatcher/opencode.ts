import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { OpenCode } from '@opencode/client';
import type { SessionMessageInfo, SessionStructuredError } from '@opencode/client';
import { z } from 'zod';
import type { Config } from './config.ts';

interface AuthOptions {
  url: string;
  password: string;
  openchamber: boolean;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

function endpoint(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('OpenCode requires an HTTP origin without URL credentials, query or fragment');
  }
  return url;
}

function directoryKey(value: string): string {
  const path = resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function httpError(status: number, fresh = false, headers?: Headers): Error {
  return Object.assign(new Error(`OpenCode HTTP ${status}`), { status, fresh_sign_in: fresh,
    ...(headers?.has('retry-after') ? { retry_after: headers.get('retry-after') } : {}) });
}

export function authenticatedFetch(options: AuthOptions): typeof globalThis.fetch {
  const origin = endpoint(options.url).origin;
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new RangeError('OpenCode timeout must be positive milliseconds');
  const fetch = options.fetch ?? globalThis.fetch;
  let cookie = '';
  let signingIn: Promise<void> | undefined;
  const signIn = (signal: AbortSignal) => {
    signingIn ??= (async () => {
      const response = await fetch(`${origin}/auth/session`, { method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: options.password }) });
      if (!response.ok) { await response.body?.cancel(); throw httpError(response.status, true); }
      cookie = response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
      await response.body?.cancel();
      if (!cookie) throw httpError(401, true);
    })().finally(() => { signingIn = undefined; });
    return signingIn;
  };
  return async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== origin) throw new TypeError('OpenCode credential origin mismatch');
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs)]);
    signal.throwIfAborted();
    if (options.openchamber && !cookie) await signIn(signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(request.headers);
      headers.delete('cookie');
      headers.delete('authorization');
      if (options.openchamber) headers.set('cookie', cookie);
      else if (options.password) headers.set('authorization', `Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`);
      const response = await fetch(request.clone(), { headers, redirect: 'error', signal });
      if (response.status === 401 && options.openchamber && attempt === 0) {
        await response.body?.cancel();
        cookie = '';
        await signIn(signal);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const error = httpError(response.status, response.status === 401 && (options.openchamber || !!options.password), response.headers);
        if (response.status === 404 && /^\/api\/session\/[^/]+/.test(new URL(request.url).pathname)) Object.assign(error, { resource: 'session' });
        throw error;
      }
      return response;
    }
    throw httpError(401, true);
  };
}

export interface TransportOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  password?: string;
  settingsPath?: string;
  readSettings?: (path: string) => unknown;
}

export interface TurnDetail {
  state: 'absent' | 'waiting' | 'running' | 'terminal';
  prompt_id: string;
  prompt_at: number | null;
  text: string;
  outcome: 'succeeded' | 'failed' | 'interrupted' | null;
  error: SessionStructuredError | null;
  assistant_id: string | null;
  completed_at: number | null;
}

function interval(messages: readonly SessionMessageInfo[], target?: string): TurnDetail | null {
  let texts: string[] = [];
  let outcome: TurnDetail['outcome'] = null;
  let error: SessionStructuredError | null = null;
  let assistant: string | null = null;
  let lastAssistant: string | null = null;
  let latestWorkAt: number | null = null;
  let completed: number | null = null;
  let idle: number | null = null;
  for (const message of messages) {
    if (message.type === 'user') {
      if (outcome === 'succeeded' && lastAssistant !== assistant) outcome = null;
      if (target === message.id || target === undefined && outcome === 'succeeded' && assistant !== null) {
        return { state: outcome === null ? 'running' : 'terminal', prompt_id: message.id, prompt_at: message.time.created, text: texts.reverse().join('\n'),
          outcome, error, assistant_id: outcome === 'failed' || outcome === 'interrupted' ? lastAssistant ?? assistant : assistant,
          completed_at: outcome === null ? null : outcome === 'succeeded' ? completed ?? idle : idle ?? completed };
      }
      texts = []; outcome = null; error = null; assistant = null; lastAssistant = null; latestWorkAt = null; completed = null; idle = null;
    } else if (message.type === 'idle' && outcome === null && (latestWorkAt === null || message.time.created >= latestWorkAt)) {
      outcome = message.outcome;
      error = message.error ?? null;
      idle = message.time.created;
    } else if (message.type === 'assistant') {
      lastAssistant ??= message.id;
      latestWorkAt = Math.max(latestWorkAt ?? 0, message.time.created, message.time.streamed ?? 0, message.time.completed ?? 0);
      if (idle !== null && latestWorkAt > idle) { outcome = null; idle = null; error = null; }
      error ??= message.error ?? null;
      if (!Number.isFinite(message.time.completed)) continue;
      if (assistant === null) {
        assistant = message.id;
        completed = message.time.completed!;
      }
      texts.push(message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'));
    }
  }
  return null;
}

const settingsSchema = z.looseObject({ desktopLocalPort: z.number().int().min(1).max(65535), desktopUiPassword: z.string().default('') });

// Constructing the client starts no service, opens no connection and subscribes to no events.
export function connect(cfg: Config, options: TransportOptions = {}) {
  let url = cfg.opencode.url;
  let password = options.password ?? process.env.INBOX_OPENCODE_PASSWORD ?? '';
  const openchamber = !url;
  if (openchamber) {
    const path = options.settingsPath ?? join(homedir(), '.config', 'openchamber', 'settings.json');
    const settings = settingsSchema.parse(options.readSettings ? options.readSettings(path) : JSON.parse(readFileSync(path, 'utf8')));
    url = `http://127.0.0.1:${settings.desktopLocalPort}`;
    password = settings.desktopUiPassword;
  }
  const client = OpenCode.make({ baseUrl: endpoint(url).href.replace(/\/$/, ''),
    fetch: authenticatedFetch({ url, password, openchamber, timeoutMs: options.timeoutMs ?? 30_000, ...(options.fetch ? { fetch: options.fetch } : {}) }) });
  const request = (signal?: AbortSignal) => signal ? { signal } : {};
  const history = async (session: string, signal?: AbortSignal) => {
    const messages: SessionMessageInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.message.list({ sessionID: session, limit: 50, ...(cursor ? { cursor } : { order: 'desc' }) }, request(signal));
      messages.push(...page.data);
      cursor = page.cursor.next ?? undefined;
      if (cursor && cursors.has(cursor)) throw new TypeError('OpenCode repeated a message cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return messages;
  };
  return {
    async create(title: string, store: string, ticket: number, signal?: AbortSignal): Promise<{ id: string }> {
      if (!store || !Number.isSafeInteger(ticket) || ticket <= 0) throw new TypeError('A durable store and ticket id are required');
      const [providerID, ...model] = cfg.opencode.model.split('/');
      if (cfg.opencode.model && (!providerID || !model.join('/'))) throw new TypeError('OpenCode model must be provider/model');
      return client.session.create({ title, location: { directory: cfg.opencode.directory },
        metadata: { inbox_dispatcher: { store_id: store, ticket } },
        ...(cfg.opencode.model ? { model: { providerID: providerID!, id: model.join('/') } } : {}) }, request(signal));
    },
    async findTicket(store: string, ticket: number, signal?: AbortSignal): Promise<string | null> {
      const matches = new Set<string>();
      for (const archived of [false, true]) {
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.session.list({ directory: cfg.opencode.directory, archived, limit: 100,
            ...(cursor ? { cursor } : { order: 'desc' }) }, request(signal));
          for (const session of page.data) {
            const tag = session.metadata?.inbox_dispatcher;
            if (tag && typeof tag === 'object' && !Array.isArray(tag) && tag.store_id === store && tag.ticket === ticket
              && directoryKey(session.location.directory) === directoryKey(cfg.opencode.directory)) matches.add(session.id);
          }
          cursor = page.cursor.next ?? undefined;
          if (cursor && cursors.has(cursor)) throw new TypeError('OpenCode repeated a session cursor');
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      if (matches.size > 1) throw Object.assign(new Error(`Duplicate OpenCode sessions for ticket ${ticket}`), { type: 'opencode.duplicate-tag', status: 400 });
      return [...matches][0] ?? null;
    },
    get: (session: string, signal?: AbortSignal) => client.session.get({ sessionID: session }, request(signal)),
    rename: (session: string, title: string, signal?: AbortSignal) => client.session.update({ sessionID: session, title }, request(signal)),
    async prompt(session: string, id: string, text: string, signal?: AbortSignal): Promise<string> {
      const admitted = await client.session.prompt({ sessionID: session, id, text, delivery: 'queue' }, request(signal));
      if (admitted.id !== id || admitted.sessionID !== session) throw Object.assign(new Error('OpenCode returned a different prompt identity'), { status: 400 });
      return admitted.id;
    },
    inbox: (session: string, signal?: AbortSignal) => client.session.inbox.list({ sessionID: session }, request(signal)),
    async turnDetail(session: string, prompt: string, signal?: AbortSignal): Promise<TurnDetail> {
      const detail = interval(await history(session, signal), prompt);
      if (detail) return detail;
      const waiting = (await client.session.inbox.list({ sessionID: session }, request(signal))).find((input) => input.id === prompt);
      return { state: waiting ? 'waiting' : 'absent', prompt_id: prompt, prompt_at: waiting?.time.created ?? null,
        text: '', outcome: null, error: null, assistant_id: null, completed_at: null };
    },
    async latestReport(session: string, signal?: AbortSignal): Promise<TurnDetail | null> {
      return interval(await history(session, signal));
    },
    async running(session: string, signal?: AbortSignal): Promise<boolean> {
      return (await client.session.active(request(signal)))[session]?.type === 'running';
    },
    archive: (session: string, archived = true, signal?: AbortSignal) => client.session.update({ sessionID: session, archived }, request(signal)),
  };
}

export type Peer = ReturnType<typeof connect>;
