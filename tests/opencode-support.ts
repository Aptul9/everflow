import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo, SessionInboxUser, SessionMessageInfo, SessionStructuredError } from '@opencode/client';

export const PEER_AT = Date.parse('2026-11-06T00:00:00Z');

export function remoteSession(id: string, directory: string, metadata: SessionInfo['metadata'] = {}): SessionInfo {
  return { id, projectID: 'synthetic-project', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: PEER_AT, updated: PEER_AT }, title: 'Synthetic session', location: { directory }, metadata };
}

export interface PeerCall {
  method: string;
  url: URL;
  body: Record<string, unknown>;
  cookie: string | undefined;
  authorization: string | undefined;
}

export async function scriptedPeer() {
  const sessions = new Map<string, SessionInfo>();
  const messages = new Map<string, SessionMessageInfo[]>();
  const admissions = new Map<string, SessionInboxUser>();
  const calls: PeerCall[] = [];
  const state = {
    loseCreate: false, losePrompt: false, loseRename: false, loseArchive: false,
    historyStatus: 200, inboxStatus: 200, wrongPromptID: false,
    hook: undefined as ((call: PeerCall, response: ServerResponse, request: IncomingMessage) => boolean | Promise<boolean>) | undefined,
  };
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const part of request) text += String(part);
      const call: PeerCall = { method: request.method!, url: new URL(request.url!, 'http://127.0.0.1'), body: text ?
        request.headers['content-type']?.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text) as Record<string, unknown>
        : {}, cookie: request.headers.cookie, authorization: request.headers.authorization };
      calls.push(call);
      if (await state.hook?.(call, response, request)) return;
      const path = call.url.pathname;
      if (call.method === 'GET' && path === '/api/session') {
        const archived = call.url.searchParams.get('archived') === 'true';
        const directory = call.url.searchParams.get('directory');
        json(response, { data: [...sessions.values()].filter((session) => !!session.time.archived === archived
          && (!directory || session.location.directory === directory)), cursor: {} });
        return;
      }
      if (call.method === 'POST' && path === '/api/session') {
        const session = remoteSession(`ses_${sessions.size + 1}`, String((call.body.location as { directory: string }).directory),
          call.body.metadata as SessionInfo['metadata']);
        session.title = String(call.body.title);
        if (call.body.model) session.model = call.body.model as NonNullable<SessionInfo['model']>;
        sessions.set(session.id, session);
        if (state.loseCreate) { state.loseCreate = false; request.socket.destroy(); return; }
        json(response, { data: session });
        return;
      }
      if (call.method === 'GET' && path === '/api/session/active') {
        json(response, { data: Object.fromEntries([...sessions.values()].filter((session) =>
          (session.time.busy ?? 0) > (session.time.idle ?? 0)).map((session) => [session.id, { type: 'running' }])) });
        return;
      }
      const match = /^\/api\/session\/([^/]+)(.*)$/.exec(path);
      const session = match ? sessions.get(decodeURIComponent(match[1]!)) : undefined;
      if (!match || !session) { json(response, { _tag: 'SessionNotFoundError', sessionID: match?.[1] }, 404); return; }
      const suffix = match[2];
      if (suffix === '' && call.method === 'GET') { json(response, { data: session }); return; }
      if (suffix === '' && call.method === 'PATCH') {
        if (typeof call.body.title === 'string') session.title = call.body.title;
        if (typeof call.body.archived === 'boolean') {
          if (call.body.archived) session.time.archived = Date.now();
          else delete session.time.archived;
        }
        session.time.updated = Date.now();
        if (state.loseRename && call.body.title !== undefined) { state.loseRename = false; request.socket.destroy(); return; }
        if (state.loseArchive && call.body.archived !== undefined) { state.loseArchive = false; request.socket.destroy(); return; }
        response.writeHead(204); response.end(); return;
      }
      if (suffix === '/model' && call.method === 'POST') {
        session.model = call.body.model as NonNullable<SessionInfo['model']>;
        response.writeHead(204); response.end(); return;
      }
      if (suffix === '/prompt' && call.method === 'POST') {
        const id = String(call.body.id);
        const admitted: SessionInboxUser = { id, sessionID: session.id, time: { created: Date.now() }, type: 'user',
          payload: { text: String(call.body.text) }, delivery: 'queue' };
        admissions.set(id, admitted);
        if (state.losePrompt) { state.losePrompt = false; request.socket.destroy(); return; }
        json(response, { data: { ...admitted, id: state.wrongPromptID ? 'msg_wrong' : id } }); return;
      }
      if (suffix === '/inbox') {
        json(response, { data: [...admissions.values()].filter((input) => input.sessionID === session.id) }, state.inboxStatus); return;
      }
      if (suffix === '/message') {
        const all = [...(messages.get(session.id) ?? [])].reverse();
        const offset = Number(call.url.searchParams.get('cursor') ?? 0);
        const limit = Number(call.url.searchParams.get('limit') ?? 50);
        json(response, { data: all.slice(offset, offset + limit), cursor: offset + limit < all.length ? { next: String(offset + limit) } : {} }, state.historyStatus); return;
      }
      json(response, { message: 'Unexpected scripted route' }, 400);
    } catch {
      json(response, { message: 'Scripted peer handler failed' }, 500);
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing scripted peer port');
  const deliver = (session: string, prompt: string) => {
    const input = admissions.get(prompt);
    if (!input) throw new Error(`No admission ${prompt}`);
    const history = messages.get(session) ?? [];
    history.push({ id: prompt, type: 'user', text: input.payload.text, time: input.time });
    messages.set(session, history);
    admissions.delete(prompt);
    sessions.get(session)!.time.busy = Date.now();
  };
  const finish = (session: string, prompt: string, text: string, outcome: 'succeeded' | 'failed' | 'interrupted' = 'succeeded',
    error?: SessionStructuredError, at = Date.now()) => {
    if (admissions.has(prompt)) deliver(session, prompt);
    const history = messages.get(session) ?? [];
    history.push({ id: `asst_${prompt}`, type: 'assistant', time: { created: at - 1, completed: at }, agent: 'build',
      model: { providerID: 'synthetic', id: 'synthetic' }, content: [{ type: 'text', text }], finish: outcome === 'succeeded' ? 'stop' : 'error',
      ...(error ? { error } : {}) });
    history.push({ id: `idle_${prompt}`, type: 'idle', time: { created: at }, outcome, ...(error ? { error } : {}) });
    messages.set(session, history);
    sessions.get(session)!.time.idle = at;
  };
  return { url: `http://127.0.0.1:${address.port}`, sessions, messages, admissions, calls, state, json, deliver, finish,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } };
}
