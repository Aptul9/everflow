import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createCipheriv } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { openDb } from '../src/dispatcher/db.ts';
import { ingest, sourceStart } from '../src/dispatcher/ingest.ts';
import { createKernel, NativeError } from '../src/windows/kernel.ts';
import { createDpapi } from '../src/windows/dpapi.ts';
import { liveTeamsAccounts, protectedTeamsCache, TeamsAuth } from '../src/watchers/teams-auth.ts';
import { createTeamsState, scanTeams, TeamsClient } from '../src/watchers/teams.ts';
import type { SourceRecord } from '../src/watchers/source.ts';
import { scratch } from './support.ts';

test('synthetic encrypted Cookies/WAL and DPAPI Local State traverse actual auth/cache/HTTP/scan/NDJSON ingestion', async () => {
  const { root } = scratch('phase7-source-pipeline-');
  const profile = join(root, 'WV2Profile_Fixture'), network = join(profile, 'Network');
  fs.mkdirSync(network, { recursive: true });
  const key = Buffer.alloc(32, 7), nonce = Buffer.alloc(12, 3), host = 'fixture.asyncgw.teams.microsoft.com';
  const now = Date.parse('2026-11-04T11:00:00Z'), since = '2026-11-04T10:00:00Z';
  const token = `synthetic.${Buffer.from(JSON.stringify({ upn: 'me@example.invalid', exp: now / 1000 + 600, oid: 'me' })).toString('base64url')}.fixture`;
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([Buffer.from('v10'), nonce, cipher.update(Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(token)])), cipher.final(), cipher.getAuthTag()]);
  const dpapi = createDpapi();
  fs.writeFileSync(join(root, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), dpapi.protect(key)]).toString('base64') } }));
  const path = join(network, 'Cookies'), writer = new DatabaseSync(path);
  const cachePath = join(root, 'dispatcher-cache', 'tokens.bin');
  using db = openDb(join(root, 'dispatcher-fixture.db'));
  sourceStart(db, { start: { lookback_minutes: 0 } }, 'teams', since);
  const native = createKernel();
  // A regression must fail here, never enumerate or duplicate a live application's handles.
  native.liveHandles = () => { throw new NativeError('fixture.live-fallback-forbidden'); };
  const shared = vi.spyOn(native, 'shared');
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,encrypted_value BLOB);");
    writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    writer.prepare("INSERT INTO cookies VALUES(?,'authtoken_asm','/',?)").run(host, encrypted);
    const before = [fs.readFileSync(path), fs.readFileSync(path + '-wal')];
    const cache = protectedTeamsCache({ path: cachePath }, dpapi);
    const auth = new TeamsAuth({ ...cache, now: () => now, harvest: (signal) => liveTeamsAccounts({ profile, scratchRoot: join(root, 'snapshots') }, signal, native) });
    const client = new TeamsClient(auth, async (url, init) => {
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer ' + token);
      return new Response(JSON.stringify(url.includes('/messages?') ? { messages: [{ id: '1', messagetype: 'RichText/Html', originalarrivaltime: '2026-11-04T10:30:00Z', from: '/contacts/8:orgid:bob', imdisplayname: 'Bob', content: '<p>Fixture &amp; body</p>' }] } : { conversations: [{ id: 'chat', threadProperties: { topic: 'Fixture topic' } }] }), { status: 200 });
    });
    const lines: string[] = [];
    await scanTeams({ knownAccounts: () => auth.knownAccounts(), accounts: (signal) => auth.accounts(signal), request: (a, url, signal) => client.request(a, url, signal) }, createTeamsState(since), (record: SourceRecord) => {
      const line = JSON.stringify(record); lines.push(line); ingest(db, JSON.parse(line));
    }, () => now);
    expect(lines).toHaveLength(3);
    expect(db.prepare('SELECT m.native_id,m.text,m.sender_is_me,c.account,c.title FROM message m JOIN conversation c ON c.id=m.conversation').get()).toEqual({
      native_id: 'chat;messageid=1', text: 'Fixture & body', sender_is_me: 0, account: 'me@example.invalid', title: 'Fixture topic',
    });
    expect(db.prepare("SELECT since FROM cursor WHERE source='teams' AND account='*'").get()!.since).toBe('2026-11-04T11:00:00.000000Z');
    expect(fs.readFileSync(cachePath).includes(Buffer.from(token))).toBe(false);
    expect([fs.readFileSync(path), fs.readFileSync(path + '-wal')]).toEqual(before);
    expect(shared).toHaveBeenCalledWith(join(root, 'Local State'));
    expect(native.resources.size).toBe(0);
  } finally { writer.close(); native[Symbol.dispose](); key.fill(0); }
});
