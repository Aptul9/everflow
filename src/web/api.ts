import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { approve } from '../dispatcher/approval.ts';
import { transaction } from '../dispatcher/db.ts';
import { retry } from '../dispatcher/jobs.ts';
import { dismiss, makeTicket, mute, muteBatch, muteTicket, TicketError } from '../dispatcher/tickets.ts';
import { HttpError, instance, withDatabase } from './instance.ts';
import type { WebInstance } from './instance.ts';
import { readState, representation, ticketDetail } from './state.ts';

export const MAX_BODY_BYTES = 32_768;
const empty = z.strictObject({});
const note = z.strictObject({ note: z.string().max(8_000).refine((value) => value.trim().length > 0, 'Note is required') });
// null mutes until unmuted
const hours = z.number().int().min(1).max(8_760).nullable();
const reason = z.strictObject({ reason: z.string().max(2_000).optional(), mute_hours: hours.optional() });
const muteFor = z.strictObject({ hours });

export function allowedHost(host: string | undefined | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function guardPost(headers: Pick<Headers, 'get'>, current: WebInstance): void {
  const host = headers.get('host');
  const supplied = Buffer.from(headers.get('x-dispatcher-token') ?? '', 'utf8');
  const expected = Buffer.from(current.token, 'utf8');
  if (!allowedHost(host, current.port) || headers.get('origin') !== `http://${host}`
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
    if (!allowedHost(request.headers.get('host'), current.port)) throw new HttpError(403, 'host.forbidden', 'Local Host required');
    return json(request, withDatabase(false, (db) => readState(db, current.config)));
  } catch (error) { return errorResponse(error); }
}

export function ticketGet(request: Request, id: string): Response {
  try {
    const current = instance();
    if (!allowedHost(request.headers.get('host'), current.port)) throw new HttpError(403, 'host.forbidden', 'Local Host required');
    return json(request, withDatabase(false, (db) => ticketDetail(db, validId(id))));
  } catch (error) { return errorResponse(error); }
}

export async function actionPost(request: Request, scope: 'ticket' | 'batch' | 'job' | 'conversation', id: string, action: string): Promise<Response> {
  try {
    const current = instance();
    guardPost(request.headers, current);
    const value = validId(id);
    const schema = scope === 'ticket' && action === 'chat' ? note : scope === 'ticket' && action === 'dismiss' ? reason : scope === 'batch' && action === 'mute' ? muteFor : empty;
    const input = await body(request, schema) as { note?: string; reason?: string; mute_hours?: number | null; hours?: number | null };
    if (!current.config.tickets.enabled) throw new HttpError(409, 'tickets.disabled', 'Tickets disabled');
    if (scope === 'ticket' && ['start', 'chat'].includes(action) && !current.config.chats.enabled) throw new HttpError(409, 'chats.disabled', 'Chats off');
    const result = withDatabase(true, (db) => transaction(db, () => {
      if (scope === 'ticket' && action === 'start') return { ticket: approve(current.config, db, value) };
      if (scope === 'ticket' && action === 'chat') return { ticket: approve(current.config, db, value, input.note!) };
      if (scope === 'ticket' && action === 'dismiss') {
        dismiss(db, value, input.reason ?? '');
        if (input.mute_hours !== undefined) muteTicket(db, value, input.mute_hours);
        return { ticket: value };
      }
      if (scope === 'batch' && action === 'ticket') return { ticket: makeTicket(db, value) };
      if (scope === 'batch' && action === 'mute') return { conversation: muteBatch(db, value, input.hours!) };
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
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
