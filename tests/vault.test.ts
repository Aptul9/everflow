import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { VAULT_LIMITS, vaultRead as read, vaultSearch as search } from '../src/core/vault.ts';
import { scratch } from './support.ts';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const { root } = scratch('phase4-vault-');
  const vault = join(root, 'kb');
  fs.mkdirSync(vault);
  const note = (path: string, text: string | Buffer) => {
    const target = join(vault, path);
    fs.mkdirSync(join(target, '..'), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  note('01_Projects/deploy.md', '# Deployment\n\nCheck literal [abc].* before restart.\n');
  note('02_Areas/client/workflows/restore.md', '# Restore workflow\n\nNested restore procedure.\n');
  return { root, vault, note };
}

test('reads nested workflow notes with explicit byte and text bounds', () => {
  const { vault } = fixture();
  expect(read(vault, '02_Areas/client/workflows/restore.md', 32)).toEqual({
    path: '02_Areas/client/workflows/restore.md', title: 'Restore workflow', text: '# Restore workflow\n\nNested resto', truncated: true,
  });
  expect(read(vault, '01_Projects/deploy.md')).toMatchObject({ path: '01_Projects/deploy.md', title: 'Deployment', truncated: false });
});

test('recursive search is literal, bounded and includes project and area workflow notes', () => {
  const { vault, note } = fixture();
  note('02_Areas/client/a.md', '# Another\nNested restore procedure.\n');
  expect(search(vault, '[abc].*', 5)).toMatchObject([{ path: '01_Projects/deploy.md', line: 3, snippet: 'Check literal [abc].* before restart.' }]);
  expect(search(vault, 'NESTED RESTORE', 1)).toHaveLength(1);
  expect(search(vault, 'Nested restore', 10)?.map((hit) => hit.path).sort()).toEqual(['02_Areas/client/a.md', '02_Areas/client/workflows/restore.md']);
  expect(search(vault, 'does not exist', 10)).toEqual([]);
});

test('P05 literal search and read reach a nested project workflow without opening or walking Unison content', () => {
  const { vault, note } = fixture();
  const path = '01_Projects/client/workflows/workflow.md';
  const text = '# Canonical workflow\n\nNested-project-marker: use the canonical local tracker.\n';
  note(path, text);
  note('01_Projects/.unison.temporary/client/workflows/workflow.md', '# Unison\nNested-project-marker: never open.\n');
  const opened = vi.spyOn(fs, 'openSync'), walked = vi.spyOn(fs, 'opendirSync');
  expect(search(vault, 'nested-project-marker', 10)).toEqual([
    { path, title: 'Canonical workflow', line: 3, snippet: 'Nested-project-marker: use the canonical local tracker.' },
  ]);
  expect(read(vault, path)).toEqual({ path, title: 'Canonical workflow', text, truncated: false });
  expect(opened.mock.calls.length).toBeGreaterThan(0);
  expect(walked.mock.calls.length).toBeGreaterThan(0);
  expect(opened.mock.calls.every(([path]) => !String(path).toLowerCase().includes('.unison.'))).toBe(true);
  expect(walked.mock.calls.every(([path]) => !String(path).toLowerCase().includes('.unison.'))).toBe(true);
});

test('literal KB tools retain historical _closed and status-closed reference notes without automatic card selection', () => {
  const { vault, note } = fixture();
  const paths = ['01_Projects/client/_closed/reference.md', '02_Areas/client/workflows/closed.md'];
  const text = '---\nstatus: closed\n---\n# Historical workflow\n\nHistorical-reference-marker.\n';
  for (const path of paths) note(path, text);
  expect(search(vault, 'historical-reference-marker', 10)?.map((hit) => hit.path).sort()).toEqual(paths);
  for (const path of paths) expect(read(vault, path)).toEqual({ path, title: 'Historical workflow', text, truncated: false });
});

test.each([
  '../outside.md', '01_Projects/../../outside.md', '/etc/passwd', 'C:/outside.md', 'C:\\outside.md',
  'C:outside.md', '\\\\server\\share\\outside.md', '//server/share/outside.md', '\\outside.md',
  '%2e%2e/outside.md', '%252e%252e/outside.md', '01_Projects/%2e%2e/outside.md',
  '．．/outside.md', '01_Projects/．．/outside.md', '01_Projects／deploy.md',
  '01_Projects/./deploy.md', '01_Projects//deploy.md', '01_Projects\\deploy.md',
  '01_Projects/.. /outside.md', '01_Projects/deploy.md:stream', '01_Projects/deploy.md.',
  '.unison.hidden/note.md', '01_Projects/.UNISON.tmp/note.md', '.unison.dead.md',
  '02_Areas/_secrets/password.md', '_secrets/password.md', '02_Areas/_SECRETS/password.md',
  'NUL.md', 'con/note.md', '', '01_Projects/deploy.txt',
])('rejects unsafe or non-note path before opening content: %s', (path) => {
  const { vault } = fixture();
  const opened = vi.spyOn(fs, 'openSync');
  expect(() => read(vault, path)).toThrow();
  expect(opened).not.toHaveBeenCalled();
});

test.each([0, -1, 1.5, NaN, Infinity, 32_769])('rejects invalid read cap %s before content access', (cap) => {
  const { vault } = fixture();
  const opened = vi.spyOn(fs, 'openSync');
  expect(() => read(vault, '01_Projects/deploy.md', cap)).toThrow();
  expect(opened).not.toHaveBeenCalled();
});

test.each([0, -1, 1.5, NaN, Infinity, 51])('rejects invalid search limit %s before walking', (limit) => {
  const { vault } = fixture();
  const opened = vi.spyOn(fs, 'opendirSync');
  expect(() => search(vault, 'restore', limit)).toThrow();
  expect(opened).not.toHaveBeenCalled();
});

test.each(['', ' '.repeat(5), 'x'.repeat(257)])('rejects empty/oversize search query before walking', (query) => {
  const { vault } = fixture();
  const opened = vi.spyOn(fs, 'opendirSync');
  expect(() => search(vault, query, 10)).toThrow();
  expect(opened).not.toHaveBeenCalled();
});

test('missing, directory, non-note and hard-linked inputs never reach a content read', () => {
  const { root, vault, note } = fixture();
  note('blob.exe', Buffer.from([0, 1, 2]));
  fs.mkdirSync(join(vault, 'directory.md'));
  fs.writeFileSync(join(root, 'outside.md'), 'Must not read');
  fs.linkSync(join(root, 'outside.md'), join(vault, 'hard.md'));
  const opened = vi.spyOn(fs, 'openSync');
  for (const path of ['missing.md', 'directory.md', 'blob.exe', 'hard.md']) expect(() => read(vault, path)).toThrow();
  expect(opened).not.toHaveBeenCalled();
});

test('binary and malformed UTF-8 masquerading as Markdown are not returned or searched', () => {
  const { vault, note } = fixture();
  note('binary.md', Buffer.from('# Hidden\nrestore\x00password'));
  note('invalid.md', Buffer.from([0xff, 0xfe, 0x00, 0x65]));
  expect(() => read(vault, 'binary.md')).toThrow(/binary|UTF-8/i);
  expect(() => read(vault, 'invalid.md')).toThrow(/binary|UTF-8/i);
  expect(search(vault, 'password', 10)).toEqual([]);
});

test('Unison trees and credential notes are excluded before traversal or content access', () => {
  const { vault, note } = fixture();
  note('02_Areas/_secrets/keys.md', '# Secret\nsynthetic-secret-marker');
  note('.unison.merge/note.md', '# Unison\nsynthetic-secret-marker');
  note('01_Projects/.unison.dead.md', '# Unison\nsynthetic-secret-marker');
  const opened = vi.spyOn(fs, 'openSync');
  const walked = vi.spyOn(fs, 'opendirSync');
  expect(search(vault, 'synthetic-secret-marker', 50)).toEqual([]);
  expect(opened.mock.calls.every(([path]) => !String(path).toLowerCase().includes('_secrets') && !String(path).toLowerCase().includes('.unison.'))).toBe(true);
  expect(walked.mock.calls.every(([path]) => !String(path).toLowerCase().includes('_secrets') && !String(path).toLowerCase().includes('.unison.'))).toBe(true);
});

test.each(['outside', 'inside', 'root', 'ancestor'])('rejects junction at %s even when target is inside root', (where) => {
  const { root, vault, note } = fixture();
  const outside = join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, 'note.md'), 'outside marker');
  note('real/note.md', 'inside marker');
  const target = where === 'outside' ? outside : join(vault, 'real');
  const junction = join(where === 'root' || where === 'ancestor' ? root : vault, 'junction');
  fs.symlinkSync(where === 'root' || where === 'ancestor' ? vault : target, junction, 'junction');
  const selectedRoot = where === 'root' ? junction : where === 'ancestor' ? join(junction, 'real') : vault;
  const selectedPath = where === 'root' ? 'real/note.md' : where === 'ancestor' ? 'note.md' : 'junction/note.md';
  const opened = vi.spyOn(fs, 'openSync');
  expect(() => read(selectedRoot, selectedPath)).toThrow(/link|root|path/i);
  expect(opened).not.toHaveBeenCalled();
  if (where === 'outside' || where === 'inside') {
    expect(search(vault, where === 'outside' ? 'outside marker' : 'inside marker', 10)?.some((hit) => hit.path.startsWith('junction/'))).toBe(false);
  }
});

test('search has a per-note and global byte bound and read never splits a UTF-8 character', () => {
  const { vault, note } = fixture();
  note('big/note.md', `${'x'.repeat(VAULT_LIMITS.searchNoteBytes)}never-read-tail`);
  note('unicode.md', 'ééé');
  expect(read(vault, 'unicode.md', 3)).toMatchObject({ text: 'é', truncated: true });
  const scanned = vi.spyOn(fs, 'readSync');
  expect(search(vault, 'never-read-tail', 50)).toEqual([]);
  const bytesRequested = scanned.mock.calls.reduce((sum, call) => sum + Number((call as readonly unknown[])[3]), 0);
  expect(bytesRequested).toBeLessThanOrEqual(VAULT_LIMITS.searchBytes);
  expect(scanned.mock.calls.length).toBeLessThanOrEqual(VAULT_LIMITS.files);
});

test('search covers a vault larger than the old 256-file bound and ranks numbered folders in order', () => {
  const { vault, note } = fixture();
  for (let index = 0; index < 400; index++) note(`00_bulk/note-${index}.md`, `# Bulk ${index}\n${'y'.repeat(4_000)}\n`);
  note('05_Daily/2026-11-08.md', '# Day\nAcme bip-group ticket mention\n');
  note('01_Projects/acme.md', '# Acme\nClient domain bip-group.com, contact via Teams.\n');
  expect(search(vault, 'bip-group', 1)).toMatchObject([{ path: '01_Projects/acme.md', line: 2 }]);
  expect(search(vault, 'bip-group', 10).map((hit) => hit.path)).toEqual(['01_Projects/acme.md', '05_Daily/2026-11-08.md']);
  expect(search(vault, 'acme teams', 10).map((hit) => hit.path)).toEqual(['01_Projects/acme.md']);
  expect(search(vault, 'deploy restart', 10)).toMatchObject([{ path: '01_Projects/deploy.md', line: 1 }]);
});

test('small notes do not consume unread bytes from the global search budget', () => {
  const { vault, note } = fixture();
  for (let index = 0; index < 60; index++) note(`small/note-${index}.md`, '# Small\nneedle');
  expect(search(vault, 'needle', 50)).toHaveLength(50);
});

test.skipIf(process.platform !== 'win32').each(['directory', 'file'])('NTFS alias of excluded %s is rejected before content open', (kind) => {
  const { vault, note } = fixture();
  const actual = kind === 'directory' ? '.unison.synthetic/note.md' : '.unison.sensitive.md';
  const alias = kind === 'directory' ? 'UNISON~1.SYN/note.md' : 'UNISON~1.MD';
  note(actual, '# Synthetic excluded\nexcluded-alias-marker\n');
  expect(fs.existsSync(join(vault, alias))).toBe(true);
  expect(fs.realpathSync.native(join(vault, alias))).toBe(fs.realpathSync.native(join(vault, actual)));
  const opened = vi.spyOn(fs, 'openSync');
  expect(() => read(vault, alias)).toThrow(/unsafe|expanded|path/i);
  expect(opened).not.toHaveBeenCalled();
  expect(search(vault, 'excluded-alias-marker', 50)).toEqual([]);
});

test.skipIf(process.platform !== 'win32').each([
  ['root', 'read'], ['ancestor', 'read'], ['root', 'search'], ['ancestor', 'search'],
] as const)('NTFS alias at excluded %s boundary blocks %s before content or enumeration', (boundary, operation) => {
  const { root } = fixture();
  const actual = join(root, '.unison.synthetic');
  fs.mkdirSync(join(actual, 'kb'), { recursive: true });
  fs.writeFileSync(join(actual, 'note.md'), '# Excluded root\nexcluded-root-marker');
  fs.writeFileSync(join(actual, 'kb/note.md'), '# Excluded ancestor\nexcluded-root-marker');
  const alias = join(root, 'UNISON~1.SYN');
  expect(fs.existsSync(alias)).toBe(true);
  expect(fs.realpathSync.native(alias)).toBe(fs.realpathSync.native(actual));
  const selected = boundary === 'root' ? alias : join(alias, 'kb');
  const opened = vi.spyOn(fs, 'openSync');
  const walked = vi.spyOn(fs, 'opendirSync');
  expect(() => operation === 'read' ? read(selected, 'note.md') : search(selected, 'excluded-root-marker', 50)).toThrow(/unsafe|expanded|path/i);
  expect(opened).not.toHaveBeenCalled();
  expect(walked).not.toHaveBeenCalled();
});

test.skipIf(process.platform !== 'win32')('ordinary tilde names and native aliases of safe notes remain readable and searchable', () => {
  const { vault, note } = fixture();
  note('ordinary~notes/safe~note.md', '# Ordinary tilde\nsafe-tilde-marker');
  note('allowed-synthetic-directory/readable-synthetic-note.md', '# Ordinary alias\nsafe-alias-marker');
  const alias = 'ALLOWE~1/READAB~1.MD';
  expect(fs.existsSync(join(vault, alias))).toBe(true);
  expect(read(vault, alias)).toMatchObject({ text: '# Ordinary alias\nsafe-alias-marker' });
  expect(read(vault, 'ordinary~notes/safe~note.md')).toMatchObject({ text: '# Ordinary tilde\nsafe-tilde-marker' });
  expect(search(vault, 'safe-tilde-marker', 50)).toMatchObject([{ path: 'ordinary~notes/safe~note.md' }]);
  expect(search(vault, 'safe-alias-marker', 50)).toMatchObject([{ path: 'allowed-synthetic-directory/readable-synthetic-note.md' }]);
});

test('native name expansion never follows an unchecked junction component', () => {
  const { root, vault } = fixture();
  const target = join(root, 'outside');
  fs.mkdirSync(target);
  fs.writeFileSync(join(target, 'note.md'), 'Synthetic outside marker');
  const junction = join(vault, 'ordinary-link');
  fs.symlinkSync(target, junction, 'junction');
  const expanded = vi.spyOn(fs.realpathSync, 'native');
  const opened = vi.spyOn(fs, 'openSync');
  expect(() => read(vault, 'ordinary-link/note.md')).toThrow(/link/i);
  expect(expanded.mock.calls.some(([path]) => String(path).startsWith(junction))).toBe(false);
  expect(opened).not.toHaveBeenCalled();
});
