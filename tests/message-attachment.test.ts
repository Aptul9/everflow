import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Config } from '../src/core/config.ts';
import { messageAttachment } from '../src/web/message-attachment.ts';
import { scratch } from './support.ts';

function setup() {
  const { root } = scratch('message-attachment-');
  const file = join(root, 'oe.secret');
  writeFileSync(file, 'synthetic-bearer\n');
  return { oe: { url: 'https://oe.example.invalid/communication/', token_file: file } } as unknown as Config;
}
const row = (ref: Record<string, unknown>, attachments: unknown[] = [{ name: 'image 1', kind: 'image' }, { name: 'a.xlsx', kind: 'file' }]) =>
  ({ source: 'teamsrelay', ref: JSON.stringify(ref), attachments: JSON.stringify(attachments) });
const ref = { chat: 'Lorenzo Fenoglio', id: '1795083262137', relay_slot: 12 };

test('asks the OE endpoint for slot, chat, mid and index with the bearer and serves images inline', async () => {
  const cfg = setup();
  const seen: { url: string; auth: string | null }[] = [];
  const response = await messageAttachment(cfg, row(ref), 1, (async (url: URL, init: RequestInit) => {
    seen.push({ url: url.href, auth: new Headers(init.headers).get('authorization') });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  }) as unknown as typeof fetch);
  expect(seen).toEqual([{ url: 'https://oe.example.invalid/communication/everflow/teams/attachment?slot=12&chat=Lorenzo+Fenoglio&mid=1795083262137&index=1', auth: 'Bearer synthetic-bearer' }]);
  expect(response.headers.get('content-type')).toBe('image/jpeg');
  expect(response.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''image%201");
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
});

test('other types download as octet-stream; relay refusals keep their status and reason', async () => {
  const cfg = setup();
  const file = await messageAttachment(cfg, row(ref), 2, (async () => new Response('x', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch);
  expect(file.headers.get('content-type')).toBe('application/octet-stream');
  expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
  await expect(messageAttachment(cfg, row(ref), 2, (async () => Response.json({ error: 'needs Always on' }, { status: 409 })) as unknown as typeof fetch))
    .rejects.toMatchObject({ status: 409, message: 'needs Always on' });
  await expect(messageAttachment(cfg, row(ref), 1, (async () => new Response('', { status: 500 })) as unknown as typeof fetch)).rejects.toMatchObject({ status: 502 });
});

test('no address for other sources, deleted messages, rows without kinds or out-of-range indexes', async () => {
  const cfg = setup();
  const never = (async () => { throw new Error('no request expected'); }) as unknown as typeof fetch;
  for (const [value, index] of [[{ ...row(ref), source: 'teams' }, 1], [row({ ...ref, deleted: true }), 1], [row(ref, [{ name: 'old.png' }]), 1], [row(ref), 3], [row({ ...ref, id: '1x' }), 1]] as const) {
    await expect(messageAttachment(cfg, value, index, never)).rejects.toMatchObject({ status: 404 });
  }
});
