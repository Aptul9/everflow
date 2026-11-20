import { readFileSync } from 'node:fs';
import type { Config } from '../core/config.ts';
import { HttpError } from './instance.ts';

// Largest attachment the page shows; the relay refuses over 20 MB itself
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Shown in place: images and PDFs; anything else is downloaded
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'application/pdf']);

// A relay attachment carries its kind (images first, then files, the relay's own count); rows saved before that, and
// other sources, keep only names, so they get no address
export function relayAttachment(source: string, ref: Record<string, unknown>): boolean {
  return source === 'teamsrelay' && ref.deleted !== true && Number.isSafeInteger(ref.relay_slot) && typeof ref.chat === 'string' && typeof ref.id === 'string' && /^\d+$/.test(ref.id);
}

export interface AttachmentRow { source: string; ref: string | null; attachments: string | null }

async function reason(response: Response): Promise<string> {
  try {
    const value = await response.json() as { error?: unknown };
    if (typeof value.error === 'string' && value.error) return value.error.slice(0, 300);
  } catch { /* the reason is optional */ }
  return `Teams relay answered ${response.status}`;
}

/**
 * The bytes of attachment `index` (1-based) of a Teams relay message, from the OE Copilot endpoint (communication service
 * /everflow/teams/attachment, the relay's saved image or the SharePoint file it downloads). 404/409/413 keep the relay's reason.
 */
export async function messageAttachment(cfg: Config, row: AttachmentRow, index: number, fetchImpl: typeof fetch = fetch): Promise<Response> {
  let ref: Record<string, unknown> = {}, list: unknown = [];
  try { ref = JSON.parse(row.ref ?? '{}'); list = JSON.parse(row.attachments ?? '[]'); } catch { /* treated as no attachment */ }
  const item = Array.isArray(list) ? list[index - 1] as { name?: unknown; kind?: unknown } | undefined : undefined;
  if (!relayAttachment(row.source, ref) || !item || item.kind !== 'image' && item.kind !== 'file') {
    throw new HttpError(404, 'attachment.not-found', 'This message has no such attachment');
  }
  if (!cfg.oe) throw new HttpError(404, 'attachment.off', 'The OE Copilot endpoint is not configured');
  let token = '';
  try { token = readFileSync(/* turbopackIgnore: true */ cfg.oe.token_file, 'utf8').trim(); } catch { /* reported below */ }
  if (!token || !/^[\x21-\x7e]+$/.test(token)) throw new HttpError(503, 'attachment.token', 'The OE Copilot token is missing');
  const url = new URL(`${cfg.oe.url.replace(/\/+$/, '')}/everflow/teams/attachment`);
  url.searchParams.set('slot', String(ref.relay_slot));
  url.searchParams.set('chat', String(ref.chat));
  url.searchParams.set('mid', String(ref.id));
  url.searchParams.set('index', String(index));
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(90_000) });
  } catch { throw new HttpError(502, 'attachment.unavailable', 'Teams relay unreachable'); }
  if ([404, 409, 413].includes(response.status)) throw new HttpError(response.status, 'attachment.unavailable', await reason(response));
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(502, 'attachment.unavailable', `Teams relay answered ${response.status}`);
  }
  if (Number(response.headers.get('content-length') ?? 0) > MAX_ATTACHMENT_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(413, 'attachment.size', 'Attachment over 20 MB');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES) { await reader.cancel().catch(() => {}); throw new HttpError(413, 'attachment.size', 'Attachment over 20 MB'); }
      chunks.push(value);
    }
  }
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const name = typeof item.name === 'string' && item.name ? item.name : `attachment-${index}`;
  const inline = INLINE.has(type);
  return new Response(Buffer.concat(chunks), { headers: {
    'content-type': inline ? type : 'application/octet-stream', 'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}` } });
}
