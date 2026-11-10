import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Config } from './config.ts';
import { transaction } from './db.ts';
import { enqueue, healthOk } from './jobs.ts';
import { assessmentPayload, attachBatch, route } from './tickets.ts';
import { utc } from './time.ts';

export class IngestError extends TypeError {
  readonly code = 'source.invalid-record';
}

const sourceSchema = z.enum(['outlook', 'teams', 'teamsrelay', 'gchat', 'gmail']);
const idSchema = z.string().refine((value) => value.trim().length > 0, 'must be a nonempty string');
const accountSchema = idSchema.refine((value) => value !== '*', 'must name a receiving account');
const timestamp = z.string().superRefine((value, context) => {
  try { utc(value); } catch { context.addIssue({ code: 'custom', message: 'must be a finite aware ISO timestamp' }); }
}).transform(utc);
const accountsSchema = z.array(accountSchema).transform((values) => [...new Set(values.map((value) => value.toLowerCase()))]);
const refSchema = z.looseObject({
  entry_id: idSchema.optional(), store_id: idSchema.optional(), chat: idSchema.optional(), id: idSchema.optional(),
  account: accountSchema.optional(), relay_slot: z.number().int().nonnegative().optional(), deleted: z.boolean().optional(),
}).catchall(z.json());
const messageSchema = z.looseObject({
  source: sourceSchema, account: accountSchema, conversation_id: idSchema, message_id: idSchema,
  sender_is_me: z.boolean(), sent_at: timestamp,
  conversation_title: z.string().nullish(), sender: z.string().nullish(), sender_name: z.string().nullish(), text: z.string().nullish(),
  attachments: z.array(z.looseObject({ name: idSchema, size: z.number().int().nonnegative().nullish() })).default([]),
  ref: refSchema.default({}),
});
const inventorySchema = z.strictObject({ source: sourceSchema, accounts: accountsSchema });
const mutedSchema = z.strictObject({ source: sourceSchema, account: accountSchema, muted: z.array(idSchema).max(10_000) });
const checkpointSchema = z.strictObject({
  source: sourceSchema, checkpoint: timestamp, accounts: accountsSchema.optional(),
  coverage: z.enum(['saved-history-replay', 'recent-topics']).optional(), observed_at: timestamp.optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new IngestError(result.error.issues.map((issue) => `${issue.path.join('.') || 'record'}: ${issue.message}`).join('; '));
  }
  return result.data;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry);
}

function jsonField(value: unknown, field: string): void {
  try {
    const text = JSON.stringify(value, (_key, entry: unknown) => {
      if (entry === undefined || ['function', 'symbol', 'bigint'].includes(typeof entry)
        || typeof entry === 'number' && !Number.isFinite(entry)) throw new TypeError('must contain only JSON values');
      return entry;
    });
    if (text === undefined) throw new TypeError('must contain only JSON values');
  } catch (error) {
    throw new IngestError(`${field}: ${error instanceof Error ? error.message : 'invalid JSON value'}`);
  }
}

function advance(db: DatabaseSync, source: string, account: string, stamp: string): void {
  const row = db.prepare('SELECT account,since FROM cursor WHERE source=? AND lower(account)=?').get(source, account.toLowerCase());
  if (!row) db.prepare('INSERT INTO cursor(source,account,since) VALUES (?,?,?)').run(source, account.toLowerCase(), stamp);
  else if (utc(String(row.since)) < stamp) db.prepare('UPDATE cursor SET since=? WHERE source=? AND account=?').run(stamp, source, row.account!);
}

function shiftMinutes(stamp: string, minutes: number): string {
  return new Date(Date.parse(stamp) + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, stamp.slice(19));
}

// This is persisted cursor policy only. Starting a watcher belongs to the runtime.
export function sourceStart(db: DatabaseSync, cfg: Pick<Config, 'start'>, source: string, at?: string): string {
  parse(sourceSchema, source);
  return transaction(db, () => {
    const now = utc(at);
    const rows = db.prepare('SELECT account,since FROM cursor WHERE source=?').all(source);
    const oldest = rows.map((row) => utc(String(row.since))).sort()[0];
    const saved = source === 'teams' ? oldest
      : rows.find((row) => row.account === '*')?.since ?? oldest;
    const floor = saved === undefined ? shiftMinutes(now, -Math.min(cfg.start.lookback_minutes, 7 * 24 * 60)) : utc(String(saved));
    const start = source === 'teamsrelay' ? floor : [floor, shiftMinutes(now, -7 * 24 * 60)].sort().at(-1)!;
    db.prepare("INSERT OR IGNORE INTO cursor(source,account,since) VALUES (?,'*',?)").run(source, start);
    return start;
  });
}

export function ingest(db: DatabaseSync, record: unknown): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new IngestError('record must be an object');
  if ('checkpoint' in record) {
    const checkpoint = parse(checkpointSchema, record);
    return transaction(db, () => {
      const now = utc();
      const future = utc(new Date(Date.now() + 5000).toISOString());
      if (checkpoint.checkpoint > future || checkpoint.observed_at && checkpoint.observed_at > future) throw new IngestError('checkpoint or observed_at is in the future');
      const known = db.prepare("SELECT account FROM cursor WHERE source=? AND account<>'*'").all(checkpoint.source).map((row) => String(row.account).toLowerCase());
      if (checkpoint.source === 'gchat') {
        if (checkpoint.coverage !== 'recent-topics' || !checkpoint.observed_at || !checkpoint.accounts?.length) throw new IngestError('gchat checkpoint requires recent-topics coverage, accounts and observed_at');
        if (known.some((account) => !checkpoint.accounts!.includes(account))) throw new IngestError('gchat checkpoint omitted known accounts');
        if (!db.prepare("SELECT 1 FROM cursor WHERE source=? AND account='*'").get(checkpoint.source)) throw new IngestError('checkpoint requires an initial source cursor');
        healthOk(db, checkpoint.source, now, { coverage: 'recent-topics', observed_at: checkpoint.observed_at });
        return true;
      }
      if (checkpoint.source === 'teamsrelay') {
        if (checkpoint.coverage !== 'saved-history-replay' || !checkpoint.observed_at) throw new IngestError('relay checkpoint requires saved-history-replay coverage and observed_at');
        if (!db.prepare("SELECT 1 FROM cursor WHERE source=? AND account='*'").get(checkpoint.source)) throw new IngestError('checkpoint requires an initial source cursor');
        healthOk(db, checkpoint.source, now, { observed_at: checkpoint.observed_at });
        return true;
      }
      if (!checkpoint.accounts?.length) throw new IngestError('source checkpoint requires complete account coverage');
      const missing = known.filter((account) => !checkpoint.accounts!.includes(account));
      if (missing.length) throw new IngestError(`source checkpoint omitted known accounts: ${missing.sort().join(', ')}`);
      for (const account of [...checkpoint.accounts, '*']) advance(db, checkpoint.source, account, checkpoint.checkpoint);
      return true;
    });
  }
  if ('accounts' in record) {
    const inventory = parse(inventorySchema, record);
    return transaction(db, () => {
      const floor = db.prepare('SELECT since FROM cursor WHERE source=?').all(inventory.source).map((row) => utc(String(row.since))).sort()[0];
      if (!floor) throw new IngestError('account inventory requires an initial source cursor');
      for (const account of inventory.accounts) {
        if (!db.prepare('SELECT 1 FROM cursor WHERE source=? AND lower(account)=?').get(inventory.source, account)) {
          db.prepare('INSERT INTO cursor(source,account,since) VALUES (?,?,?)').run(inventory.source, account, floor);
        }
      }
      return true;
    });
  }
  if ('muted' in record) {
    const state = parse(mutedSchema, record);
    return transaction(db, () => {
      const account = state.account.toLowerCase();
      db.prepare('DELETE FROM source_mute WHERE source=? AND account=?').run(state.source, account);
      const insert = db.prepare('INSERT OR IGNORE INTO source_mute(source,account,native_id) VALUES (?,?,?)');
      for (const id of state.muted) insert.run(state.source, account, id);
      return true;
    });
  }
  if ('ref' in record) jsonField(record.ref, 'ref');
  if ('attachments' in record) jsonField(record.attachments, 'attachments');
  const message = parse(messageSchema, record);
  return transaction(db, () => {
    const now = utc();
    const identity = JSON.stringify([message.account.toLowerCase(), message.message_id]);
    const previous = db.prepare('SELECT m.*,c.native_id AS conversation_id,c.title AS conversation_title FROM message m JOIN conversation c ON c.id=m.conversation WHERE m.source=? AND m.message_id=?')
      .get(message.source, identity);
    if (previous && previous.conversation_id !== message.conversation_id) throw new IngestError('message identity already belongs to another conversation');
    const previousRef = previous ? JSON.parse(String(previous.ref ?? '{}')) as Record<string, unknown> : {};
    // Deletion is durable evidence. A replay without a tombstone cannot resurrect the native item.
    if (previousRef.deleted === true && message.ref.deleted !== true) return false;
    const ref = { ...previousRef, ...message.ref };
    const text = ref.deleted === true ? '' : message.text ?? null;
    const attachments = ref.deleted === true ? [] : message.attachments;
    const sender = (message.sender ?? '').toLowerCase();
    const after = [sender, message.sender_name ?? '', message.sender_is_me, message.sent_at, text ?? '', attachments, ref];
    if (previous) {
      const before = [previous.sender ?? '', previous.sender_name ?? '', previous.sender_is_me === 1, utc(String(previous.sent_at)), previous.text ?? '',
        JSON.parse(String(previous.attachments ?? '[]')), JSON.parse(String(previous.ref ?? '{}'))];
      const title = message.conversation_title || previous.conversation_title;
      if (stable(before) === stable(after) && title === previous.conversation_title) return false;
    }
    let conversation = db.prepare('SELECT id,last_message_at FROM conversation WHERE source=? AND lower(account)=? AND native_id=?')
      .get(message.source, message.account.toLowerCase(), message.conversation_id);
    if (!conversation) {
      const inserted = db.prepare('INSERT INTO conversation(source,account,native_id,title,last_message_at) VALUES (?,?,?,?,?)')
        .run(message.source, message.account, message.conversation_id, message.conversation_title ?? null, message.sent_at);
      conversation = { id: inserted.lastInsertRowid, last_message_at: message.sent_at };
    } else {
      const last = conversation.last_message_at && utc(String(conversation.last_message_at)) >= message.sent_at ? conversation.last_message_at : message.sent_at;
      db.prepare("UPDATE conversation SET title=COALESCE(NULLIF(?,''),title),last_message_at=? WHERE id=?")
        .run(message.conversation_title ?? null, last, conversation.id!);
    }
    let person: number | bigint | null = null;
    const column = sender.includes('@') ? 'email' : message.source === 'teams' ? 'teams_oid' : message.source === 'gchat' ? 'gchat_id' : null;
    if (sender && column) {
      db.prepare(`INSERT INTO person(${column},name) VALUES (?,?) ON CONFLICT(${column}) DO UPDATE SET name=COALESCE(NULLIF(excluded.name,''),name)`)
        .run(sender, message.sender_name ?? null);
      person = db.prepare(`SELECT id FROM person WHERE ${column}=?`).get(sender)!.id as number | bigint;
    }
    if (previous) {
      const sentAt = utc(String(previous.sent_at)) === message.sent_at ? previous.sent_at : message.sent_at;
      db.prepare('UPDATE message SET person=?,sender=?,sender_name=?,sender_is_me=?,sent_at=?,text=?,attachments=?,ref=?,batch=NULL,stored_at=? WHERE id=?')
        .run(person, sender, message.sender_name ?? null, Number(message.sender_is_me), sentAt!, text,
          JSON.stringify(attachments), JSON.stringify(ref), now, previous.id!);
    } else {
      db.prepare(`INSERT INTO message(source,message_id,native_id,conversation,person,sender,sender_name,sender_is_me,sent_at,text,attachments,ref,stored_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(message.source, identity, message.message_id, conversation.id!, person, sender, message.sender_name ?? null, Number(message.sender_is_me),
          message.sent_at, text, JSON.stringify(attachments), JSON.stringify(ref), now);
    }
    advance(db, message.source, message.account, message.sent_at);
    return true;
  });
}

function triageForConversation(db: DatabaseSync, conversation: number) {
  return db.prepare(`SELECT j.id,j.state,j.payload,b.id AS batch FROM job j JOIN batch b ON b.id=json_extract(j.payload,'$.batch')
    WHERE j.kind='triage' AND j.state IN ('queued','running','parked') AND b.conversation=? ORDER BY j.id LIMIT 1`).get(conversation);
}

function inputChain(db: DatabaseSync, ticket: number): boolean {
  return db.prepare(`SELECT 1 FROM job WHERE ticket=? AND (state IN ('queued','running','parked') AND kind IN ('triage','start_chat','forward','collect')
    OR reserved_at IS NOT NULL AND turn_id IS NULL)`).get(ticket) !== undefined
    || db.prepare("SELECT 1 FROM turn WHERE ticket=? AND state IN ('prepared','admitted','running')").get(ticket) !== undefined;
}

// Returns durable job ids newly scheduled or merged. Importing this module starts no runtime.
export function schedule(db: DatabaseSync, cfg: Config, at?: string): number[] {
  return transaction(db, () => {
    if (!cfg.tickets.enabled) return [];
    const now = utc(at);
    const scheduled = new Set<number>();
    for (const conversation of db.prepare('SELECT DISTINCT c.id,c.source FROM conversation c JOIN message m ON m.conversation=c.id WHERE m.batch IS NULL ORDER BY c.id').all()) {
      const pending = db.prepare("SELECT id,sent_at,sender_is_me,json_extract(ref,'$.mentions_me') AS mention FROM message WHERE conversation=? AND batch IS NULL ORDER BY id").all(conversation.id!);
      const last = pending.map((message) => utc(String(message.sent_at))).sort().at(-1)!;
      if (last > shiftMinutes(now, -Number(cfg.windows[String(conversation.source)] ?? 300) / 60)) continue;
      const existing = triageForConversation(db, Number(conversation.id));
      if (existing) {
        if (existing.state === 'parked') {
          db.prepare('UPDATE message SET batch=? WHERE conversation=? AND batch IS NULL').run(existing.batch!, conversation.id!);
          const routed = route(db, Number(existing.batch), now, cfg.jobs.reopen_days);
          db.prepare('UPDATE job SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(assessmentPayload(db, cfg, Number(existing.batch), routed, now)), now, existing.id!);
        }
        continue;
      }
      const own = pending.every((message) => message.sender_is_me === 1);
      const until = db.prepare('SELECT muted_until FROM conversation WHERE id=?').get(conversation.id!)?.muted_until;
      // Muted in the source app: only an @mention of the owner reaches triage
      const sourceMuted = db.prepare(`SELECT 1 FROM source_mute s JOIN conversation c ON s.source=c.source AND s.account=lower(c.account) AND s.native_id=c.native_id
        WHERE c.id=?`).get(conversation.id!) !== undefined && !pending.some((message) => message.mention === 1);
      // A follow-up in a chat that feeds a running ticket chat always reaches that chat, muted or not
      const working = db.prepare(`SELECT 1 FROM ticket_conversation l JOIN ticket t ON t.id=l.ticket WHERE l.conversation=? AND l.kind IN ('primary','linked')
        AND t.lifecycle='active' AND t.approved_at IS NOT NULL AND t.merged_into IS NULL`).get(conversation.id!) !== undefined;
      const muted = !own && !working && (typeof until === 'string' && utc(until) > now || sourceMuted);
      // A chat muted in the source app stays off the board too; its messages remain as context for a later mention
      const id = Number(db.prepare('INSERT INTO batch(conversation,state,created_at,done_at,outcome,cleared_at) VALUES (?,?,?,?,?,?)')
        .run(conversation.id!, own || muted ? 'done' : 'pending', now, own || muted ? now : null, own ? 'answered' : muted ? 'muted' : 'pending',
          muted && sourceMuted ? now : null).lastInsertRowid);
      db.prepare('UPDATE message SET batch=? WHERE conversation=? AND batch IS NULL').run(id, conversation.id!);
      if (own) {
        const linked = db.prepare("SELECT ticket FROM ticket_conversation WHERE conversation=? AND kind IN ('primary','linked')").get(conversation.id!);
        if (linked) attachBatch(db, id, Number(linked.ticket), now);
      }
    }
    for (const batch of db.prepare("SELECT id FROM batch WHERE state='pending' AND outcome IN ('pending','triage','routed') ORDER BY id").all()) {
      const id = Number(batch.id);
      if (db.prepare("SELECT 1 FROM job WHERE kind='triage' AND json_extract(payload,'$.batch')=? AND state IN ('queued','running','parked')").get(id)) continue;
      const routed = route(db, id, now, cfg.jobs.reopen_days);
      if (routed.mode === 'closed' || routed.mode === 'forward') continue;
      scheduled.add(enqueue(db, 'triage', `triage:batch:${id}`, assessmentPayload(db, cfg, id, routed, now), routed.ticket ?? undefined));
      db.prepare("UPDATE batch SET outcome='triage' WHERE id=?").run(id);
    }
    if (cfg.chats.enabled) {
      const waiting = new Map<number, number[]>();
      for (const batch of db.prepare(`SELECT b.id,b.ticket FROM batch b JOIN ticket t ON t.id=b.ticket
        WHERE b.state='pending' AND b.outcome='routed' AND t.lifecycle='active' ORDER BY b.id`).all()) {
        const ticket = Number(batch.ticket);
        const ids = waiting.get(ticket) ?? [];
        ids.push(Number(batch.id));
        waiting.set(ticket, ids);
      }
      for (const [ticket, ids] of waiting) {
        const parked = db.prepare("SELECT id FROM job WHERE ticket=? AND kind='forward' AND state='parked' ORDER BY id LIMIT 1").get(ticket);
        if (!parked && inputChain(db, ticket)) continue;
        const seq = Number(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS seq FROM job').get()!.seq);
        const id = enqueue(db, 'forward', `forward:ticket:${ticket}:${seq}`, { batch_ids: ids }, ticket);
        scheduled.add(id);
        for (const batch of ids) db.prepare("UPDATE batch SET outcome='forward' WHERE id=?").run(batch);
      }
    }
    return [...scheduled];
  });
}
