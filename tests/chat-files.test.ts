import { mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { expect, test } from 'vitest';
import { ChatFiles, docxHtml, housekeeping, MAX_FILE_BYTES, mentions, references, sanitize } from '../src/web/chat-files.ts';
import { scratch } from './support.ts';

const AT = Date.parse('2026-11-17T16:00:00Z');

// The OpenChamber history item shapes seen on a real ticket chat (GET /api/session/<id>/message)
const tool = (name: string, input: Record<string, unknown>, at: number, extra: Record<string, unknown> = {}, status = 'completed') =>
  ({ type: 'tool', id: `toolu_${name}_${at}`, name, executed: false, time: { created: at - 1000, completed: at }, state: { status, input, ...extra } });
const assistant = (id: string, at: number, content: unknown[]) => ({ id, type: 'assistant', time: { created: at - 5000, completed: at }, content });

function home() {
  const { root } = scratch('chat-files-');
  const user = join(root, 'home'), vault = join(user, 'Vault');
  for (const folder of ['99_Inbox', '05_Daily', '01_Projects', 'reports']) mkdirSync(join(vault, folder), { recursive: true });
  mkdirSync(join(root, 'elsewhere'), { recursive: true });
  return { root, user, vault, chats: join(user, 'everflow-chats', 'client') };
}

test('history items: write and edit targets count, read does not, documents only when named by the assistant or a shell', () => {
  const dir = '/home/u/everflow-chats/client', user = '/home/u';
  const item = assistant('msg_1', AT, [
    { type: 'reasoning', text: 'I will write /home/u/notes/thought.docx' },
    tool('write', { path: '/home/u/Vault/99_Inbox/prompt.md', content: '# x' }, AT + 1),
    tool('edit', { path: 'drafts/reply.md', oldString: 'a', newString: 'b' }, AT + 2),
    tool('read', { path: '/home/u/Vault/02_Areas/infra.md' }, AT + 3),
    tool('write', { path: '/home/u/failed.md', content: '' }, AT + 4, {}, 'error'),
    tool('shell', { command: 'pandoc in.md -o ~/out/report.docx' }, AT + 5, { content: [{ type: 'text', text: 'written /home/u/out/annex.pdf' }] }),
    tool('grep', { pattern: 'x', path: '/home/u/Vault/03.pdf' }, AT + 6),
    { type: 'text', text: 'Saved `/home/u/out/final.xlsx` and https://example.invalid/files/a.pdf, see also /home/u/slides.pptx.' },
  ]);
  expect(mentions(item, dir, user)).toEqual([
    ['/home/u/Vault/99_Inbox/prompt.md', AT + 1],
    ['/home/u/everflow-chats/client/drafts/reply.md', AT + 2],
    ['/home/u/out/report.docx', AT + 5],
    ['/home/u/out/annex.pdf', AT + 5],
    ['/home/u/out/final.xlsx', AT],
    ['/home/u/slides.pptx', AT],
  ]);
  expect(mentions({ id: 'msg_2', type: 'user', text: 'look at /home/u/in.docx', time: { created: AT } }, dir, user)).toEqual([]);
  expect(['/v/05_Daily/2026-11-17.md', '/v/01_Projects/Board.md', '/v/99_Inbox/everflow-tool-issues.md'].every(housekeeping)).toBe(true);
  expect(['/v/99_Inbox/prompt.md', '/v/01_Projects/client/Board.md.bak', '/v/01_Projects/everflow.md'].some(housekeeping)).toBe(false);
});

// OpenChamber's history: newest first, pages joined by cursor.next
function history(sessions: Record<string, { directory: string; items: unknown[] }>) {
  const calls: string[] = [];
  return { calls, get: async (path: string) => {
    calls.push(path);
    const url = new URL(path, 'http://oc.invalid');
    const [, , , id, rest] = url.pathname.split('/');
    const session = sessions[decodeURIComponent(id!)];
    if (!session) throw Object.assign(new Error('gone'), { status: 404, code: 'chat.not-found' });
    if (!rest) return { data: { id, location: { directory: session.directory } } };
    expect(url.searchParams.get('directory')).toBe(session.directory);
    const limit = Number(url.searchParams.get('limit')), start = Number(url.searchParams.get('cursor') ?? 0);
    const items = [...session.items].reverse();
    const data = items.slice(start, start + Math.min(limit, 2));
    return { data, cursor: { previous: null, next: start + 2 < items.length ? String(start + 2) : null } };
  } };
}

test('listing: files that exist now, newest touch first, housekeeping and files outside the home folder left out', async () => {
  const { root, user, vault, chats } = home();
  const prompt = join(vault, '99_Inbox', 'prompt.md'), report = join(vault, 'reports', 'audit.docx'), notes = join(vault, 'reports', 'notes');
  writeFileSync(prompt, '# Prompt\n');
  writeFileSync(report, 'docx bytes');
  writeFileSync(notes, 'plain text without extension\n');
  writeFileSync(join(vault, '05_Daily', '2026-11-17.md'), '- day\n');
  writeFileSync(join(root, 'elsewhere', 'secret.md'), 'outside\n');
  symlinkSync(join(root, 'elsewhere', 'secret.md'), join(vault, 'reports', 'link.md'));
  const items = [
    assistant('msg_1', AT, [tool('write', { path: prompt, content: '# Prompt' }, AT)]),
    assistant('msg_2', AT + 60_000, [tool('edit', { path: join(vault, '05_Daily', '2026-11-17.md'), oldString: '', newString: '- day' }, AT + 60_000)]),
    assistant('msg_3', AT + 120_000, [tool('read', { path: notes }, AT + 120_000), tool('write', { path: join(root, 'elsewhere', 'secret.md'), content: '' }, AT + 120_000)]),
    assistant('msg_4', AT + 180_000, [{ type: 'text', text: `Report at ${report}, draft at ${join(vault, 'reports', 'missing.docx')}` }]),
    assistant('msg_5', AT + 240_000, [tool('write', { path: join(vault, 'reports', 'link.md'), content: '' }, AT + 240_000), tool('write', { path: notes, content: 'x' }, AT + 30_000)]),
  ];
  const oc = history({ ses_a: { directory: chats, items } });
  const files = new ChatFiles(oc, user);
  const listed = await files.list('ses_a');
  expect(listed.map((file) => [file.name, file.kind, file.touched])).toEqual([
    ['audit.docx', 'docx', new Date(AT + 180_000).toISOString()],
    ['notes', 'text', new Date(AT + 30_000).toISOString()],
    ['prompt.md', 'markdown', new Date(AT).toISOString()],
  ]);
  expect(listed[2]).toMatchObject({ path: prompt, size: 9, mtime: expect.stringMatching(/Z$/) });
  // all five items across three pages on the first listing
  expect(oc.calls.filter((call) => call.includes('/message?'))).toHaveLength(3);
  // a later listing reads the newest page, sees nothing new and stops; a new item is picked up
  oc.calls.length = 0;
  items.push(assistant('msg_6', AT + 300_000, [tool('write', { path: join(chats, 'new.md'), content: 'n' }, AT + 300_000)]));
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(chats, 'new.md'), 'n');
  expect((await files.list('ses_a')).map((file) => file.name)).toEqual(['new.md', 'audit.docx', 'notes', 'prompt.md']);
  expect(oc.calls.filter((call) => call.includes('/message?'))).toHaveLength(2);
  await expect(files.list('ses_gone')).rejects.toMatchObject({ status: 404, code: 'chat.not-found' });
});

test('reading: only a listed file, after its real path, inside the home folder, regular, at most 10 MB', async () => {
  const { root, user, vault, chats } = home();
  const prompt = join(vault, '99_Inbox', 'prompt.md'), big = join(vault, 'reports', 'big.pdf'), image = join(vault, 'reports', 'chart.png');
  const sheet = join(vault, 'reports', 'sheet.xlsx'), escape = join(vault, 'reports', 'escape.md'), outside = join(root, 'elsewhere', 'secret.md');
  writeFileSync(prompt, '# Prompt\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  writeFileSync(big, ''); truncateSync(big, MAX_FILE_BYTES + 1);
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(sheet, 'PK');
  writeFileSync(outside, 'outside\n');
  writeFileSync(escape, 'inside for now\n');
  const items = [assistant('msg_1', AT, [prompt, big, image, sheet, escape, outside].map((path, index) => tool('write', { path, content: '' }, AT + index)))];
  const files = new ChatFiles(history({ ses_a: { directory: chats, items } }), user);
  expect((await files.list('ses_a')).map((file) => file.name).sort()).toEqual(['big.pdf', 'chart.png', 'escape.md', 'prompt.md', 'sheet.xlsx']);

  expect(await files.read('ses_a', prompt)).toMatchObject({ body: expect.stringContaining('| 1 | 2 |'), type: 'text/markdown; charset=utf-8', download: false });
  expect(await files.read('ses_a', image)).toMatchObject({ type: 'image/png', download: false });
  expect(await files.read('ses_a', sheet, true)).toMatchObject({ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'sheet.xlsx', download: true });
  await expect(files.read('ses_a', sheet)).rejects.toMatchObject({ status: 415, code: 'file.download-only' });
  await expect(files.read('ses_a', big)).rejects.toMatchObject({ status: 413, code: 'file.too-large' });
  // named by the chat but outside the home folder: refused for where it is
  await expect(files.read('ses_a', outside)).rejects.toMatchObject({ status: 403, code: 'file.outside' });
  await expect(files.read('ses_a', `${vault}/05_Daily/../99_Inbox/prompt.md`)).rejects.toMatchObject({ code: 'file.not-listed' });
  await expect(files.read('ses_a', '/etc/passwd')).rejects.toMatchObject({ code: 'file.not-listed' });
  // a listed file swapped for a link out of the home folder after it was listed
  rmSync(escape);
  symlinkSync(outside, escape);
  await expect(files.read('ses_a', escape)).rejects.toMatchObject({ code: expect.stringMatching(/^file\.(?:not-listed|outside)$/) });
  expect((await files.list('ses_a')).map((file) => file.name)).not.toContain('escape.md');
  // a home folder reached through a link still resolves its own files
  const linked = join(root, 'home-link');
  symlinkSync(user, linked);
  expect((await new ChatFiles(history({ ses_a: { directory: chats, items } }), linked).list('ses_a')).length).toBe(4);
});

test('a clicked file opens when the history names it anywhere: read-only files and text paths too, never others, never out of home', async () => {
  const { root, user, vault, chats } = home();
  mkdirSync(join(chats, 'notes'), { recursive: true });
  const written = join(chats, 'demo.md'), plan = join(chats, 'notes', 'plan.md'), mentioned = join(vault, 'reports', 'seen.txt');
  const quiet = join(vault, 'reports', 'never-named.md'), escape = join(vault, 'reports', 'escape.md'), outside = join(root, 'elsewhere', 'secret.md');
  for (const [path, text] of [[written, '# Demo'], [plan, '# Plan'], [mentioned, 'seen'], [quiet, 'quiet'], [outside, 'outside']] as const) writeFileSync(path, text);
  symlinkSync(outside, escape);
  const items = [
    assistant('msg_1', AT, [tool('write', { path: written, content: '# Demo' }, AT)]),
    assistant('msg_2', AT + 1000, [tool('read', { path: 'notes/plan.md' }, AT + 1000), tool('read', { filePath: escape }, AT + 1000),
      tool('shell', { command: `cat ${join(vault, 'reports', 'gone.md')}` }, AT + 1000)]),
    assistant('msg_3', AT + 2000, [{ type: 'text', text: `I looked at \`${mentioned}\`, and ${join(chats, '..', 'everflow-chats', 'client', 'demo.md')}.` }]),
  ];
  const files = new ChatFiles(history({ ses_a: { directory: chats, items } }), user);
  // what opens by itself stays as before: only the written file
  expect((await files.list('ses_a')).map((file) => file.path)).toEqual([written]);

  // read only, given relative to the session folder as a tool row shows it, or absolute as a text link carries it
  expect(await files.describe('ses_a', 'notes/plan.md')).toMatchObject({ path: plan, name: 'plan.md', kind: 'markdown', touched: new Date(AT + 1000).toISOString() });
  expect((await files.describe('ses_a', plan)).path).toBe(plan);
  expect(await files.read('ses_a', 'notes/plan.md')).toMatchObject({ body: '# Plan', type: 'text/markdown; charset=utf-8' });
  expect(await files.read('ses_a', mentioned)).toMatchObject({ body: 'seen', type: 'text/plain; charset=utf-8' });
  // a listed file under another spelling is the listed entry, so the page focuses its tab
  expect(await files.describe('ses_a', 'demo.md')).toMatchObject({ path: written, touched: new Date(AT).toISOString() });

  // never named, outside the home folder through a link, gone, or spelled with ..
  await expect(files.describe('ses_a', quiet)).rejects.toMatchObject({ status: 404, code: 'file.not-listed' });
  await expect(files.read('ses_a', quiet)).rejects.toMatchObject({ code: 'file.not-listed' });
  await expect(files.describe('ses_a', escape)).rejects.toMatchObject({ status: 403, code: 'file.outside' });
  await expect(files.read('ses_a', escape)).rejects.toMatchObject({ status: 403, code: 'file.outside' });
  await expect(files.describe('ses_a', join(vault, 'reports', 'gone.md'))).rejects.toMatchObject({ status: 404, code: 'file.missing' });
  await expect(files.describe('ses_a', `${chats}/notes/../notes/plan.md`)).rejects.toMatchObject({ code: 'file.not-listed' });
  await expect(files.describe('ses_a', '/etc/passwd')).rejects.toMatchObject({ code: 'file.not-listed' });
  await expect(files.describe('ses_a', '../../../etc/passwd')).rejects.toMatchObject({ code: 'file.not-listed' });
});

test('references: every tool path input, path words in text and commands, relative ones from the session folder', () => {
  const dir = '/home/u/chats', user = '/home/u';
  const item = assistant('msg_1', AT, [
    tool('read', { path: 'notes/plan.md' }, AT + 1),
    tool('grep', { pattern: 'x', path: '/home/u/Vault' }, AT + 2),
    tool('shell', { command: 'cat ~/out/log.txt | head' }, AT + 3),
    { type: 'text', text: 'See `/home/u/a.md:12`, https://example.invalid/x.md and (notes/b.md).' },
  ]);
  expect(references(item, dir, user)).toEqual([
    ['/home/u/chats/notes/plan.md', AT + 1],
    ['/home/u/Vault', AT + 2],
    ['/home/u/out/log.txt', AT + 3],
    ['/home/u/a.md', AT],
    ['/home/u/chats/notes/b.md', AT],
  ]);
});

async function docx(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('Word documents: converted to HTML and sanitized, no script, no event handler, images only as data: URIs', async () => {
  const html = await docxHtml(await docx('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Audit trail</w:t></w:r></w:p><w:p><w:r><w:t>Ten years of logs &lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>'));
  expect(html).toBe('<h1>Audit trail</h1><p>Ten years of logs &lt;script&gt;alert(1)&lt;/script&gt;</p>');
  const dirty = '<p onclick="steal()">Hi<script>alert(1)</script></p><img src="x" onerror="alert(2)"><img src="https://evil.invalid/t.png">'
    + '<img src="data:image/png;base64,iVBORw0KGgo=" alt="chart" onload="x()"><a href="javascript:alert(3)">js</a><a href="https://example.invalid/" target="_self">ok</a>'
    + '<iframe src="https://evil.invalid"></iframe><style>body{display:none}</style><table><tr><td colspan="2" style="color:red">cell</td></tr></table>';
  const clean = sanitize(dirty);
  expect(clean).not.toMatch(/<script|onerror|onclick|onload|javascript:|<iframe|<style|evil\.invalid|style=/i);
  expect(clean).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="chart" />');
  expect(clean).toContain('<a href="https://example.invalid/" target="_blank" rel="noopener noreferrer">ok</a>');
  expect(clean).toContain('<td colspan="2">cell</td>');
  expect(clean.match(/<img/g)).toHaveLength(1);
});
