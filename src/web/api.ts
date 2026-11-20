import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { approve } from '../core/approval.ts';
import { transaction } from '../core/db.ts';
import { markSeen, readInitiatives, requestRefresh } from '../core/initiative-state.ts';
import { retry, startNow } from '../core/jobs.ts';
import { requestModelOptions, saveSetting } from '../core/settings.ts';
import { clearBatch, clearTicket, close, dismiss, makeTicket, mute, MUTE_MAX_MINUTES, muteBatch, muteTicket, pauseInput, TicketError } from '../core/tickets.ts';
import { HttpError, instance, withDatabase } from './instance.ts';
import type { WebInstance } from './instance.ts';
import { readState, representation, ticketDetail } from './state.ts';

import { messageAttachment } from './message-attachment.ts';
import type { AttachmentRow } from './message-attachment.ts';

export const MAX_BODY_BYTES = 32_768;
const empty = z.strictObject({});
const note = z.strictObject({ note: z.string().max(8_000).refine((value) => value.trim().length > 0, 'Note is required') });
const question = z.strictObject({ note: z.string().max(8_000).optional() });
// null mutes until unmuted. Hours are still taken from a page served by an older build.
const minutes = z.number().int().min(1).max(MUTE_MAX_MINUTES).nullable();
const hours = z.number().int().min(1).max(8_760).nullable();
const reason = z.strictObject({ reason: z.string().max(2_000).optional(), mute_minutes: minutes.optional(), mute_hours: hours.optional() })
  .refine((input) => input.mute_minutes === undefined || input.mute_hours === undefined, 'Mute in minutes or hours, not both');
const muteFor = z.strictObject({ minutes: minutes.optional(), hours: hours.optional() })
  .refine((input) => (input.minutes === undefined) !== (input.hours === undefined), 'Mute minutes required');
const inMinutes = (value: number | null | undefined, legacyHours: number | null | undefined) =>
  value !== undefined ? value : legacyHours === undefined ? undefined : legacyHours === null ? null : legacyHours * 60;

// publicOrigin: [web] public_origin, the HTTPS address of the authenticating reverse proxy in front of the loopback port
export function allowedHost(host: string | undefined | null, port: number, publicOrigin?: string): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || !!publicOrigin && `https://${host?.toLowerCase()}` === publicOrigin;
}

function expectedOrigin(host: string, port: number): string {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` ? `http://${host}` : `https://${host.toLowerCase()}`;
}

export function guardPost(headers: Pick<Headers, 'get'>, current: WebInstance): void {
  const host = headers.get('host');
  const supplied = Buffer.from(headers.get('x-everflow-token') ?? '', 'utf8');
  const expected = Buffer.from(current.token, 'utf8');
  if (!allowedHost(host, current.port, current.config.web.public_origin) || headers.get('origin')?.toLowerCase() !== expectedOrigin(host!, current.port)
    || supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    throw new HttpError(403, 'action.forbidden', 'Action token or Origin rejected. Reload this page before retrying.');
  }
}

function validId(id: string): number {
  const value = Number(id);
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(value)) throw new HttpError(400, 'input.id', 'A positive safe integer id is required');
  return value;
}

async function body(request: Request, schema: z.ZodType): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
    throw new HttpError(415, 'input.content-type', 'Content-Type application/json is required');
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new HttpError(413, 'input.size', 'JSON body exceeds 32768 bytes');
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new HttpError(413, 'input.size', 'JSON body exceeds 32768 bytes'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new HttpError(400, 'input.json', 'A valid JSON object is required'); }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, 'input.fields', parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '));
  return parsed.data;
}

export function errorResponse(error: unknown): Response {
  const failure = error instanceof HttpError ? error : error instanceof TicketError
    ? new HttpError(error.code === 'ticket.not-found' ? 404 : error.code === 'ticket.conflict' ? 409 : 400, error.code, error.message)
    : new HttpError(503, 'instance.unavailable', 'Local instance unavailable');
  return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status, headers: { 'cache-control': 'no-store' } });
}

function json(request: Request, value: unknown): Response {
  const { json, etag } = representation(value);
  const matches = request.headers.get('if-none-match')?.split(',').some((candidate) => candidate.trim() === '*' || candidate.trim().replace(/^W\//, '') === etag);
  return new Response(matches ? null : json, { status: matches ? 304 : 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', etag } });
}

export function stateGet(request: Request): Response {
  try {
    const current = instance();
    if (!allowedHost(request.headers.get('host'), current.port, current.config.web.public_origin)) throw new HttpError(403, 'host.forbidden', 'Local Host required');
    return json(request, withDatabase(false, (db) => readState(db, current.config)));
  } catch (error) { return errorResponse(error); }
}

export function ticketGet(request: Request, id: string): Response {
  try {
    const current = instance();
    if (!allowedHost(request.headers.get('host'), current.port, current.config.web.public_origin)) throw new HttpError(403, 'host.forbidden', 'Local Host required');
    return json(request, withDatabase(false, (db) => ticketDetail(db, validId(id))));
  } catch (error) { return errorResponse(error); }
}

// An image or file of a source message, fetched from the Teams relay for the Messages list
export async function attachmentGet(request: Request, id: string, index: string): Promise<Response> {
  try {
    const current = instance();
    if (!allowedHost(request.headers.get('host'), current.port, current.config.web.public_origin)) throw new HttpError(403, 'host.forbidden', 'Local Host required');
    const message = validId(id), position = validId(index);
    const row = withDatabase(false, (db) => db.prepare('SELECT source,ref,attachments FROM message WHERE id=?').get(message)) as AttachmentRow | undefined;
    if (!row) throw new HttpError(404, 'message.not-found', `Message ${message} not found`);
    return await messageAttachment(current.config, row, position);
  } catch (error) { return errorResponse(error); }
}

const settingBody = z.union([z.strictObject({ key: z.string().min(1).max(64), value: z.string().max(200) }), z.strictObject({ refresh: z.literal(true) })]);

// Saves a model/effort choice, or asks the daemon to refresh the picker options
export async function settingPost(request: Request): Promise<Response> {
  try {
    const current = instance();
    guardPost(request.headers, current);
    const input = await body(request, settingBody) as { key: string; value: string } | { refresh: true };
    const result = withDatabase(true, (db) => ({ setting: 'refresh' in input ? requestModelOptions(db) : saveSetting(db, input.key, input.value) }));
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}

const pauseBody = z.strictObject({ source: z.string().min(1).max(64), account: z.string().min(1).max(320), paused: z.boolean() });

export function initiativesGet(request: Request): Response {
  try {
    const current = instance();
    if (!allowedHost(request.headers.get('host'), current.port, current.config.web.public_origin)) throw new HttpError(403, 'host.forbidden', 'Local Host required');
    return json(request, withDatabase(false, (db) => readInitiatives(db, current.config)));
  } catch (error) { return errorResponse(error); }
}

// refresh: the daemon sums the initiatives up again at its next tick; seen: counts a page open for the pilot
export async function initiativesPost(request: Request, action: string): Promise<Response> {
  try {
    const current = instance();
    guardPost(request.headers, current);
    await body(request, empty);
    if (action !== 'refresh' && action !== 'seen') throw new HttpError(404, 'action.not-found', 'Action not found');
    if (action === 'refresh' && !Object.keys(current.config.initiatives).length) throw new HttpError(409, 'initiatives.none', 'No initiative configured');
    const result = withDatabase(true, (db) => action === 'refresh' ? (requestRefresh(db), { requested: true }) : { views: markSeen(db, current.config) });
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}

// Pauses a source account (its new input waits before triage and chat forwards) or switches it back on
export async function inputPost(request: Request): Promise<Response> {
  try {
    const current = instance();
    guardPost(request.headers, current);
    const input = await body(request, pauseBody) as { source: string; account: string; paused: boolean };
    const result = withDatabase(true, (db) => ({ input: pauseInput(db, input.source, input.account, input.paused), paused: input.paused }));
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}

// The ticket's chat in OpenChamber web ([web] chat_origin): the page frames OpenChamber's chat view with the session and
// the folder OpenChamber keeps it in, asked here rather than taken from the config, since a ticket's client can change
function chatSession(current: WebInstance, ticket: number): string {
  if (!current.chat) throw new HttpError(404, 'chat.off', 'OpenChamber web is not configured');
  const row = withDatabase(false, (db) => db.prepare('SELECT session_id FROM ticket WHERE id=?').get(ticket)) as { session_id: string | null } | undefined;
  if (!row) throw new HttpError(404, 'ticket.not-found', `Ticket ${ticket} not found`);
  if (!row.session_id) throw new HttpError(409, 'chat.none', `Ticket #${ticket} has no chat yet`);
  return row.session_id;
}

// errors from the daemon's module graph carry status and code as plain fields
function fromChat(error: unknown): never {
  const { status, code, message } = error as { status?: unknown; code?: unknown; message?: unknown };
  throw typeof status === 'number' && typeof code === 'string' && typeof message === 'string' ? new HttpError(status, code, message)
    : new HttpError(502, 'chat.unavailable', 'OpenChamber unavailable');
}

async function openChat(current: WebInstance, ticket: number): Promise<{ ticket: number; session_id: string; directory: string }> {
  const session = chatSession(current, ticket);
  const directory = await current.chat!.open(session).catch(fromChat);
  return { ticket, session_id: session, directory };
}

// The files the ticket's chat wrote, and one of them: text, sanitized HTML for a Word document, or bytes for the page to
// show from a blob: URL (the page host refuses to be framed, so a file is never a page address)
async function chatFiles(current: WebInstance, ticket: number): Promise<Response> {
  const session = chatSession(current, ticket);
  if (!current.files) throw new HttpError(404, 'chat.off', 'OpenChamber web is not configured');
  const files = await current.files.list(session).catch(fromChat);
  return Response.json({ ticket, files }, { headers: { 'cache-control': 'no-store' } });
}

async function chatFile(current: WebInstance, ticket: number, path: string, download: boolean): Promise<Response> {
  const session = chatSession(current, ticket);
  if (!current.files) throw new HttpError(404, 'chat.off', 'OpenChamber web is not configured');
  const file = await current.files.read(session, path, download).catch(fromChat);
  return new Response(typeof file.body === 'string' ? file.body : new Uint8Array(file.body), { headers: { 'content-type': file.type, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
    ...(file.download ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` } : {}) } });
}

const fileBody = z.strictObject({ path: z.string().min(1).max(4_096), download: z.boolean().optional() });
const fileInfo = z.strictObject({ path: z.string().min(1).max(4_096) });

// A file clicked in the chat: its entry for the viewer when the chat's history names it, listed or not
async function chatFileInfo(current: WebInstance, ticket: number, path: string): Promise<Response> {
  const session = chatSession(current, ticket);
  if (!current.files) throw new HttpError(404, 'chat.off', 'OpenChamber web is not configured');
  const file = await current.files.describe(session, path).catch(fromChat);
  return Response.json({ ticket, file }, { headers: { 'cache-control': 'no-store' } });
}

export async function actionPost(request: Request, scope: 'ticket' | 'batch' | 'job' | 'conversation', id: string, action: string): Promise<Response> {
  try {
    const current = instance();
    guardPost(request.headers, current);
    const value = validId(id);
    const schema = scope === 'ticket' && action === 'chat' ? note : scope === 'ticket' && action === 'discuss' ? question : scope === 'ticket' && ['dismiss', 'close'].includes(action) ? reason
      : scope === 'batch' && action === 'mute' ? muteFor : scope === 'ticket' && action === 'chat-file' ? fileBody : scope === 'ticket' && action === 'chat-file-info' ? fileInfo : empty;
    const input = await body(request, schema) as { note?: string; reason?: string; mute_minutes?: number | null; mute_hours?: number | null; minutes?: number | null; hours?: number | null; path?: string; download?: boolean };
    if (!current.config.tickets.enabled) throw new HttpError(409, 'tickets.disabled', 'Tickets disabled');
    if (scope === 'ticket' && action === 'open-chat') return Response.json(await openChat(current, value), { headers: { 'cache-control': 'no-store' } });
    if (scope === 'ticket' && action === 'chat-files') return await chatFiles(current, value);
    if (scope === 'ticket' && action === 'chat-file') return await chatFile(current, value, input.path!, input.download === true);
    if (scope === 'ticket' && action === 'chat-file-info') return await chatFileInfo(current, value, input.path!);
    if (scope === 'ticket' && ['start', 'chat', 'discuss', 'start-now'].includes(action) && !current.config.chats.enabled) throw new HttpError(409, 'chats.disabled', 'Chats off');
    const result = withDatabase(true, (db) => transaction(db, () => {
      if (scope === 'ticket' && action === 'start') return { ticket: approve(current.config, db, value) };
      if (scope === 'ticket' && action === 'chat') return { ticket: approve(current.config, db, value, input.note!) };
      if (scope === 'ticket' && action === 'discuss') return { ticket: approve(current.config, db, value, input.note ?? '', true) };
      if (scope === 'ticket' && action === 'dismiss') {
        dismiss(db, value, input.reason ?? '');
        const muted = inMinutes(input.mute_minutes, input.mute_hours);
        if (muted !== undefined) muteTicket(db, value, muted);
        return { ticket: value };
      }
      if (scope === 'ticket' && action === 'close') return { ticket: close(db, value, input.reason ?? '') };
      if (scope === 'ticket' && action === 'clear') return { ticket: clearTicket(db, value) };
      if (scope === 'ticket' && action === 'start-now') {
        const owner = db.prepare('SELECT lifecycle,approved_at FROM ticket WHERE id=?').get(value);
        if (!owner) throw new HttpError(404, 'ticket.not-found', `Ticket ${value} not found`);
        if (owner.lifecycle !== 'active' || !owner.approved_at || !startNow(db, value)) throw new HttpError(409, 'ticket.conflict', `Ticket ${value} has no chat input waiting to start`);
        return { ticket: value };
      }
      if (scope === 'batch' && action === 'ticket') return { ticket: makeTicket(db, value, undefined, 'you', current.config) };
      if (scope === 'batch' && action === 'mute') return { conversation: muteBatch(db, value, inMinutes(input.minutes, input.hours)!) };
      if (scope === 'batch' && action === 'clear') return { batch: clearBatch(db, value) };
      if (scope === 'conversation' && action === 'unmute') return { conversation: mute(db, value, 0) };
      if (scope === 'job' && action === 'retry') {
        const job = db.prepare('SELECT state FROM job WHERE id=?').get(value);
        if (!job) throw new HttpError(404, 'job.not-found', `Job ${value} not found`);
        if (job.state !== 'parked') throw new HttpError(409, 'job.conflict', `Job ${value} is not parked`);
        retry(db, value);
        return { job: value };
      }
      throw new HttpError(404, 'action.not-found', 'Action not found');
    }));
    // The daemon's retitle worker, registered process-wide (this route runs in Next's module graph)
    (globalThis as Record<symbol, (() => void) | undefined>)[Symbol.for('everflow.retitle.wake')]?.();
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
