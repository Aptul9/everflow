import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { expect } from 'vitest';
import { loadConfig } from '../src/core/config.ts';
import { prepareStart } from '../src/core/db.ts';
import { ingest } from '../src/core/ingest.ts';
import * as jobs from '../src/core/jobs.ts';
import { attachBatch } from '../src/core/tickets.ts';
import { scratch } from './support.ts';

export const AT = '2026-11-06T00:00:00.000000Z';

export function chatFixture(url: string) {
  const files = scratch('phase5-chat-');
  const cfg = loadConfig(files.config);
  cfg.tickets.enabled = true;
  cfg.chats.enabled = true;
  cfg.opencode.url = url;
  cfg.jobs.backoff_jitter = 0;
  return { ...files, cfg };
}

export function proposed(db: DatabaseSync, fields: Record<string, SQLInputValue> = {}): number {
  prepareStart(db, undefined, AT);
  const values = { title: 'Synthetic ticket', client: 'synthetic-client', summary: 'Exact summary', ask: 'Exact ask', proposal: 'Exact proposal',
    kb_notes: '["01_Projects/synthetic.md"]', created_at: AT, last_activity_at: AT, ...fields };
  return Number(db.prepare(`INSERT INTO ticket(${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`)
    .run(...Object.values(values)).lastInsertRowid);
}

export function addBatch(db: DatabaseSync, owner: number, options: { own?: boolean; text?: string; conversation?: string; native?: string } = {}): number {
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM message').get()!.n) + 1;
  const record = { source: 'outlook', account: 'synthetic@example.invalid', conversation_id: options.conversation ?? `conversation-${n}`,
    conversation_title: `Source ${n}`, message_id: options.native ?? `native-${n}`, sender_is_me: options.own ?? false,
    sender: options.own ? 'synthetic@example.invalid' : 'sender@example.invalid', sender_name: options.own ? 'Antonio' : 'Third party',
    sent_at: '2026-11-05T23:50:00Z', text: options.text ?? `Third-party source ${n}: RCA-12`,
    attachments: [{ name: 'synthetic.txt', size: 12 }], ref: { entry_id: `synthetic-${n}`, store_id: 'synthetic-store' } };
  ingest(db, record);
  const conversation = Number(db.prepare('SELECT id FROM conversation WHERE native_id=?').get(record.conversation_id)!.id);
  const active = db.prepare('SELECT lifecycle FROM ticket WHERE id=?').get(owner)!.lifecycle === 'active';
  const state = options.own || !active ? 'done' : 'pending';
  const outcome = options.own ? 'answered' : active ? 'routed' : 'proposed';
  const batch = Number(db.prepare('INSERT INTO batch(conversation,ticket,state,outcome,created_at,done_at) VALUES (?,?,?,?,?,?)')
    .run(conversation, owner, state, outcome, AT, state === 'done' ? AT : null).lastInsertRowid);
  db.prepare('UPDATE message SET batch=? WHERE conversation=? AND batch IS NULL').run(batch, conversation);
  if (!db.prepare('SELECT 1 FROM ticket_conversation WHERE ticket=? AND conversation=?').get(owner, conversation)) {
    db.prepare('INSERT INTO ticket_conversation(ticket,conversation,kind,"by",created_at) VALUES (?,?,?,\'rule\',?)')
      .run(owner, conversation, 'linked', AT);
  }
  attachBatch(db, batch, owner, AT);
  return batch;
}

export function claimed(db: DatabaseSync, cfg: ReturnType<typeof loadConfig>, run = 'phase5-run') {
  const job = jobs.claim(db, cfg, run);
  expect(job).toBeTruthy();
  if (!job) throw new Error('Expected eligible Phase 5 job');
  return job;
}

export function row(db: DatabaseSync, table: 'ticket' | 'job' | 'turn' | 'batch', id: number) {
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)!;
}
