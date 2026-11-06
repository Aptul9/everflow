import type { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { openDb } from '../src/dispatcher/db.ts';
import * as api from '../src/dispatcher/tickets.ts';
import { scratch } from './support.ts';

const { extractRefs } = api;
const AT = '2026-11-06T00:00:00.000000Z';

function ticket(db: DatabaseSync) {
  return Number(db.prepare('INSERT INTO ticket(title,created_at) VALUES (?,?)').run('References', AT).lastInsertRowid);
}

test('normalizes Jira keys with the retained project and number boundaries', () => {
  expect(extractRefs('rca-12 AB-1 a1b2c3d4e5-1234567 A-1 ABCDEFGHIJK-1 AB-0 AB-01 AB-12345678', 'message'))
    .toEqual([
      { kind: 'jira', key: 'RCA-12', url: null, seen_in: 'message' },
      { kind: 'jira', key: 'AB-1', url: null, seen_in: 'message' },
      { kind: 'jira', key: 'A1B2C3D4E5-1234567', url: null, seen_in: 'message' },
    ]);
});

test.each(['UTF', 'ISO', 'SHA', 'RFC', 'TLS', 'SSL', 'AES', 'RSA', 'HTTP', 'WIN', 'COVID', 'CVE', 'GPT', 'PCI', 'MD'])(
  'retains the full Jira exclusion prefix %s', (prefix) => {
    expect(extractRefs(`${prefix}-123 ${prefix.toLowerCase()}-1 RCA-12`, 'message').map((ref: { key: string }) => ref.key)).toEqual(['RCA-12']);
  },
);

test('base64 and base64url payloads are not decoded into ticket references or confused with encoding labels', () => {
  const plain = 'RCA-12 INC0012345 https://github.com/a/b/pull/3';
  const encoded = [Buffer.from(plain).toString('base64'), Buffer.from(plain).toString('base64url')];
  expect(extractRefs(`Content-Transfer-Encoding: base64\n${encoded.join('\n')}\nUTF-8 ISO-8601 SHA-256 AES-256`, 'message')).toEqual([]);
  expect(extractRefs(`${encoded.join(' ')} RCA-12`, 'message')).toEqual([{ kind: 'jira', key: 'RCA-12', url: null, seen_in: 'message' }]);
});

test('extracts ServiceNow kinds without losing zero padding and deduplicates repeats', () => {
  expect(extractRefs('inc0012345 CHG000123 RITM0000007 task42 INC0012345 XINC123 INC-123', 'chat'))
    .toEqual([
      { kind: 'snow', key: 'INC0012345', url: null, seen_in: 'chat' },
      { kind: 'snow', key: 'CHG000123', url: null, seen_in: 'chat' },
      { kind: 'snow', key: 'RITM0000007', url: null, seen_in: 'chat' },
      { kind: 'snow', key: 'TASK42', url: null, seen_in: 'chat' },
      { kind: 'jira', key: 'INC-123', url: null, seen_in: 'chat' },
    ]);
});

test('parses only genuine GitHub pull paths and retains the evidence URL', () => {
  const url = 'https://GitHub.com/Owner/Repo/pull/003?diff=split#discussion';
  expect(extractRefs(`(${url}). https://github.com/owner/repo/pull/3/ https://github.com/owner/repo/issues/3
    https://github.com.evil.invalid/owner/repo/pull/3 https://evil.invalid/github.com/owner/repo/pull/3
    https://github.com/owner/repo/pull/3/files https://github.com/owner/repo/pull/0`, 'message'))
    .toEqual([{ kind: 'github_pr', key: 'https://github.com/owner/repo/pull/3', url: 'https://github.com/Owner/Repo/pull/003?diff=split#discussion', seen_in: 'message' }]);
});

test('normalizes GitLab group paths on hosted and private GitLab URLs', () => {
  expect(extractRefs(`https://GitLab.com/Group/Sub/Repo/-/merge_requests/12?x=1#note,
    https://gitlab.com/group/sub/repo/-/merge_requests/12/ https://git.internal.invalid/Team/Repo/-/merge_requests/1;
    https://gitlab.com/group/repo/-/issues/12`, 'chat'))
    .toEqual([
      { kind: 'gitlab_mr', key: 'https://gitlab.com/group/sub/repo/-/merge_requests/12', url: 'https://gitlab.com/Group/Sub/Repo/-/merge_requests/12?x=1#note', seen_in: 'chat' },
      { kind: 'gitlab_mr', key: 'https://git.internal.invalid/team/repo/-/merge_requests/1', url: 'https://git.internal.invalid/Team/Repo/-/merge_requests/1', seen_in: 'chat' },
    ]);
});

test('one Azure DevOps PR shares identity across modern and visualstudio URLs', () => {
  const modern = 'https://DEV.AZURE.COM/Org/My%20Project/_git/Repo/pullrequest/12?view=files#discussion';
  const legacy = 'https://ORG.visualstudio.com/DefaultCollection/My%20Project/_git/REPO/pullrequest/012/';
  const first = extractRefs(modern, 'message');
  const second = extractRefs(legacy, 'chat');
  expect(first).toEqual([{ kind: 'ado_pr', key: 'https://dev.azure.com/org/my%20project/_git/repo/pullrequest/12', url: modern.replace('DEV.AZURE.COM', 'dev.azure.com'), seen_in: 'message' }]);
  expect(second).toEqual([{ kind: 'ado_pr', key: first[0]!.key, url: legacy.replace('ORG.visualstudio.com', 'org.visualstudio.com'), seen_in: 'chat' }]);
  expect(extractRefs(`${modern} ${legacy}`, 'message')).toHaveLength(1);
});

test('keeps URL evidence for keys mentioned inside issue tracker links', () => {
  expect(extractRefs('RCA-12 https://jira.example.invalid/browse/rca-12?x=1. INC0042 https://snow.example.invalid/INC0042', 'message'))
    .toEqual([
      { kind: 'jira', key: 'RCA-12', url: 'https://jira.example.invalid/browse/rca-12?x=1', seen_in: 'message' },
      { kind: 'snow', key: 'INC0042', url: 'https://snow.example.invalid/INC0042', seen_in: 'message' },
    ]);
});

test('rejects invalid reference input instead of accepting arbitrary seen_in values', () => {
  expect(() => extractRefs('RCA-1', 'outside' as never)).toThrow(/seen_in/);
  expect(() => extractRefs(null as never, 'message')).toThrow(/text/);
});

test('persists references once per ticket and emits idempotent reference timeline events', () => {
  using db = openDb(scratch('phase3-refs-').path);
  const first = ticket(db);
  const second = ticket(db);
  const refs = extractRefs('RCA-12 https://github.com/a/b/pull/3', 'message');
  expect(api.addRefs?.(db, first, refs, AT)).toBe(2);
  expect(api.addRefs?.(db, first, extractRefs('rca-12 https://GitHub.com/A/B/pull/3?x=1', 'chat'), AT)).toBe(0);
  expect(api.addRefs?.(db, second, refs, AT)).toBe(2);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_ref').get()?.n).toBe(4);
  expect(db.prepare("SELECT COUNT(*) AS n FROM timeline WHERE kind='ref'").get()?.n).toBe(4);
  expect(db.prepare('SELECT seen_in FROM ticket_ref WHERE ticket=?').all(first)).toEqual([{ seen_in: 'message' }, { seen_in: 'message' }]);
});

test('reference insertion and history roll back together on a late write error', () => {
  using db = openDb(scratch('phase3-refs-').path);
  const owner = ticket(db);
  db.exec("CREATE TRIGGER reject_ref_history BEFORE INSERT ON timeline WHEN NEW.kind='ref' BEGIN SELECT RAISE(ABORT,'injected ref history failure'); END");
  expect(() => api.addRefs?.(db, owner, extractRefs('RCA-12', 'message'), AT)).toThrow('injected ref history failure');
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_ref').get()?.n).toBe(0);
  expect(db.isTransaction).toBe(false);
});

test('later URL evidence enriches an existing reference without duplicating its event or original seen_in', () => {
  using db = openDb(scratch('phase3-refs-').path);
  const owner = ticket(db);
  api.addRefs(db, owner, extractRefs('RCA-12', 'message'), AT);
  expect(api.addRefs(db, owner, extractRefs('https://jira.example.invalid/browse/RCA-12', 'chat'), AT)).toBe(0);
  expect(db.prepare('SELECT url,seen_in FROM ticket_ref').get()).toEqual({ url: 'https://jira.example.invalid/browse/RCA-12', seen_in: 'message' });
  expect(db.prepare("SELECT link FROM timeline WHERE kind='ref'").get()?.link).toBe('https://jira.example.invalid/browse/RCA-12');
  expect(db.prepare("SELECT COUNT(*) AS n FROM timeline WHERE kind='ref'").get()?.n).toBe(1);
});

test('reference insertion cannot silently ignore an invalid kind or seen_in', () => {
  using db = openDb(scratch('phase3-refs-').path);
  const owner = ticket(db);
  expect(() => api.addRefs(db, owner, [{ kind: 'issues', key: 'invalid', url: null, seen_in: 'message' }] as never, AT)).toThrow();
  expect(() => api.addRefs(db, owner, [{ kind: 'jira', key: 'RCA-12', url: null, seen_in: 'outside' }] as never, AT)).toThrow();
  expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_ref').get()?.n).toBe(0);
});

test('single-quoted and Markdown-wrapped URLs retain the same PR identity', () => {
  expect(extractRefs("'https://github.com/A/B/pull/3' [PR](https://github.com/a/b/pull/3).", 'message'))
    .toEqual([{ kind: 'github_pr', key: 'https://github.com/a/b/pull/3', url: 'https://github.com/A/B/pull/3', seen_in: 'message' }]);
});
