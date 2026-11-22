import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { transaction } from './db.ts';
import { enqueue } from './jobs.ts';
import { TicketError } from './tickets.ts';
import type { Ticket } from './tickets.ts';
import { utc } from './time.ts';

// discuss: the chat opens with the ticket context and waits for Antonio's decision instead of doing the work
export function approve(cfg: Config, db: DatabaseSync, ticket: number, note = '', discuss = false): number {
  if (typeof note !== 'string') throw new TicketError('ticket.invalid-input', 'Approval note must be a string');
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM ticket WHERE id=?').get(ticket);
    if (!row) throw new TicketError('ticket.not-found', `Ticket ${ticket} not found`);
    const owner = row as unknown as Ticket;
    if (!cfg.tickets.enabled || !cfg.chats.enabled) return ticket;
    // A wait is approved with no chat: Discuss opens its first one, with Antonio's question as the note
    if (discuss && owner.approved_at && owner.lifecycle === 'active' && !owner.session_id
      && !db.prepare("SELECT 1 FROM job WHERE ticket=? AND kind='start_chat'").get(ticket)) {
      const now = utc();
      db.prepare('UPDATE ticket SET approval_note=?,last_activity_at=? WHERE id=?').run(note, now, ticket);
      db.prepare("INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (?,?,'approval','you',?,?)")
        .run(ticket, now, ['Discuss in chat first', note].filter(Boolean).join('\n'), `approval:ticket:${ticket}`);
      enqueue(db, 'start_chat', `start:ticket:${ticket}`, { discuss: true }, ticket);
      return ticket;
    }
    if (owner.approved_at) {
      if (owner.approval_note !== note) throw new TicketError('ticket.conflict', 'Ticket already approved with a different note');
      return ticket;
    }
    if (owner.lifecycle !== 'proposed') throw new TicketError('ticket.conflict', 'Only a proposed ticket can be approved');
    const now = utc();
    db.prepare("UPDATE ticket SET lifecycle='active',approved_at=?,approval_note=?,last_activity_at=? WHERE id=?").run(now, note, now, ticket);
    db.prepare("INSERT INTO timeline(ticket,at,kind,actor,body,event_key) VALUES (?,?,'approval','you',?,?)")
      .run(ticket, now, discuss ? ['Discuss in chat first', note].filter(Boolean).join('\n') : note, `approval:ticket:${ticket}`);
    enqueue(db, 'start_chat', `start:ticket:${ticket}`, discuss ? { discuss: true } : {}, ticket);
    return ticket;
  });
}
