import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CliError, parseCommand } from '../src/cli.ts';
import { approve } from '../src/core/approval.ts';
import { loadConfig } from '../src/core/config.ts';
import { openDb } from '../src/core/db.ts';
import { createTicket, stage } from '../src/core/tickets.ts';
import { scratch } from './support.ts';

const AT = '2026-11-21T09:00:00.000000Z';
const BASE = ['--config', resolve('config.toml'), '--artifact', resolve('build-receipt.json')];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AT));
});
afterEach(() => vi.useRealTimers());

function fixture() {
  const files = scratch('ticket-create-');
  const cfg = loadConfig(files.config);
  cfg.tickets.enabled = true;
  cfg.chats.enabled = true;
  cfg.clients = { acme: { accounts: [], domains: ['acme.invalid'], keywords: [] } };
  return { ...files, cfg };
}

test('a hand-made ticket is proposed, has no conversation and keeps its fields and KB notes', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const id = createTicket(db, cfg, { client: 'acme', title: '  Cut one node  ', summary: 'Saves 350 USD a month', ask: 'Remove one node',
    proposal: '1. Drain\n2. Scale', kb_notes: ['01_Projects/acme/plan.md'] });
  expect(db.prepare('SELECT title,client,summary,ask,proposal,kb_notes,lifecycle,approved_at,session_id,created_at FROM ticket WHERE id=?').get(id)).toEqual({
    title: 'Cut one node', client: 'acme', summary: 'Saves 350 USD a month', ask: 'Remove one node', proposal: '1. Drain\n2. Scale',
    kb_notes: '["01_Projects/acme/plan.md"]', lifecycle: 'proposed', approved_at: null, session_id: null, created_at: AT });
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_conversation WHERE ticket=?').get(id)!.n).toBe(0);
  expect(db.prepare('SELECT kind,actor,body,event_key FROM timeline WHERE ticket=?').all(id)).toEqual([
    { kind: 'comment', actor: 'you', body: 'Created by hand', event_key: `create:ticket:${id}` }]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM job').get()!.n).toBe(0);
  expect(stage(db, id)).toBe('Needs you');
});

test('the same key returns the ticket made the first time', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const first = createTicket(db, cfg, { client: 'acme', title: 'Return reservation', key: 'acme-cost-1.1' });
  expect(createTicket(db, cfg, { client: 'acme', title: 'Return reservation again', key: 'acme-cost-1.1' })).toBe(first);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()!.n).toBe(1);
  expect(createTicket(db, cfg, { client: 'acme', title: 'Other', key: 'acme-cost-1.2' })).not.toBe(first);
});

test('unknown client, empty title, unsafe note path, bad key and extra fields are refused before any write', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  expect(() => createTicket(db, cfg, { client: 'nobody', title: 'X' })).toThrow(/Unknown configured client/);
  expect(() => createTicket(db, cfg, { client: 'acme', title: '   ' })).toThrow();
  expect(() => createTicket(db, cfg, { client: 'acme', title: 'X', kb_notes: ['../secrets.md'] })).toThrow(/Unsafe/);
  expect(() => createTicket(db, cfg, { client: 'acme', title: 'X', kb_notes: ['notes.txt'] })).toThrow(/Unsafe/);
  expect(() => createTicket(db, cfg, { client: 'acme', title: 'X', key: 'has space' })).toThrow(/Key/);
  expect(() => createTicket(db, cfg, { client: 'acme', title: 'X', lifecycle: 'active' })).toThrow();
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket').get()!.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM timeline').get()!.n).toBe(0);
});

test('approving a hand-made ticket opens its chat like any proposed ticket', () => {
  const { path, cfg } = fixture();
  using db = openDb(path);
  const id = createTicket(db, cfg, { client: 'acme', title: 'Buy reservation' });
  expect(approve(cfg, db, id, 'Go ahead')).toBe(id);
  expect(db.prepare('SELECT lifecycle,approval_note FROM ticket WHERE id=?').get(id)).toEqual({ lifecycle: 'active', approval_note: 'Go ahead' });
  expect(db.prepare("SELECT kind,ticket FROM job WHERE kind='start_chat'").all()).toEqual([{ kind: 'start_chat', ticket: id }]);
});

test('ticket create parses its fields, repeats --kb-note and refuses them on other commands', () => {
  const parsed = parseCommand([...BASE, 'ticket', 'create', '--client', 'acme', '--title', 'Cut one node', '--summary', 'S', '--ask', 'A',
    '--proposal', 'P', '--kb-note', '01_Projects/a.md', '--kb-note', '02_Areas/b.md', '--key', 'acme-1'], undefined);
  expect(parsed).toMatchObject({ name: 'ticket create', args: [], ticket: { client: 'acme', title: 'Cut one node', summary: 'S', ask: 'A', proposal: 'P',
    kb_notes: ['01_Projects/a.md', '02_Areas/b.md'], key: 'acme-1' } });
  expect(parseCommand([...BASE, 'ticket', 'create', '--client', 'acme', '--title', 'T'], undefined).ticket).toEqual({ client: 'acme', title: 'T' });
  expect(() => parseCommand([...BASE, 'ticket', 'create', '--title', 'T'], undefined)).toThrow(CliError);
  expect(() => parseCommand([...BASE, 'ticket', 'create', '--client', 'acme'], undefined)).toThrow(CliError);
  expect(() => parseCommand([...BASE, 'ticket', 'create', '--client', 'acme', '--title', 'T', '--title', 'U'], undefined)).toThrow(CliError);
  expect(() => parseCommand([...BASE, 'ticket', 'create', '7', '--client', 'acme', '--title', 'T'], undefined)).toThrow(CliError);
  expect(() => parseCommand([...BASE, 'ticket', 'close', '7', '--title', 'T'], undefined)).toThrow(CliError);
  expect(() => parseCommand([...BASE, 'status', '--kb-note', 'a.md'], undefined)).toThrow(CliError);
});
