import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openDb } from '../src/core/db.ts';
import { explainerDue, explainerInputs, generateExplainer, parseA, parseB, refreshExplainer } from '../src/core/explainer.ts';
import { readGuide, requestExplainer, setDismissed, writeSetting } from '../src/core/initiative-state.ts';
import type { ExplainerSource } from '../src/lib/web-types.ts';
import { kbFixture, provider, scriptedPeer } from './kb-support.ts';

// Wednesday 2026-11-18 10:00 in Rome
const AT = '2026-11-18T09:00:00Z';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT)); });
afterEach(() => { vi.useRealTimers(); });

const NOTE = `# Demo

## Status
Status text with [[people]] and [[people|Alice]] and [[keys#x]] and [[missing]] and [[extra]] and [[demo]].

## Goal
Goal text.

## Empty

## Log
- 2026-11-18 09:50 - SENT Alice: thanks.
- 2026-11-11 16:53 (Teams clock) - Bob asked 4 questions.
- 2026-10-01 12:00 - Old entry.
- not an entry
`;

function fixture() {
  const kb = kbFixture();
  const { cfg } = kb;
  const put = (path: string, text: string) => { mkdirSync(join(cfg.vault.path, path, '..'), { recursive: true }); writeFileSync(join(cfg.vault.path, path), text); };
  put('01_Projects/demo.md', NOTE);
  put('01_Projects/extra.md', `# Extra\n${'x'.repeat(70_000)}`);
  put('02_Areas/people.md', '# People\nAlice leads.\n');
  put('02_Areas/_secrets/keys.md', '# Keys\nhunter2\n');
  cfg.initiatives = { demo: { title: 'Demo', client: 'acme', note: '01_Projects/demo.md', related: ['01_Projects/extra.md'] } };
  return kb;
}

const A = {
  title: 'Demo', one_liner: 'One line', why: ['Why'], role: 'Role',
  teams: [{ id: 'acme', name: 'Acme', plain: 'Client', kind: 'client', people: ['alice', 'bob'] }],
  people: [
    { id: 'alice', name: 'Alice Smith', short: 'Alice', team: 'acme', role: 'Lead', plain: 'Leads', ask_for: 'Design', how: 'Teams', src: ['L1'] },
    { id: 'bob', name: 'Bob Jones', short: 'Bob', team: 'acme', role: 'Dev', plain: 'Codes', ask_for: 'Code', how: 'Mail', src: ['L99'] },
  ],
  concepts: [
    { id: 'rbac', title: 'RBAC', plain: 'Roles', analogy: 'Keys', say: 'We map roles.', diagram: { t: 'flow', i: ['a', 'b'] }, src: ['L1', 'Z9'] },
    { id: 'odd', title: 'Odd', plain: 'Shape', analogy: '', say: '', diagram: { t: 'zigzag', i: ['a'] }, src: [] },
  ],
  glossary: [{ id: 'rbac', term: 'RBAC', aliases: ['role based'], short: 'Roles', long: 'Roles here', general: true, src: [] }],
  warnings: [{ title: 'Careful', text: 'Why', src: ['L2'] }, { title: 'Invented', text: 'No source', src: [] }],
  ask_who: [{ need: 'Design', who: 'alice', how: 'Teams' }, { need: 'Code', who: 'bob', how: 'Mail' }],
};

const B = {
  phases: [
    { id: 'p1', title: 'Phase', plain: 'First', items: [{ title: 'Doing', status: 'doing', note: '', src: ['L1'] }, { title: 'Invented', status: 'todo', note: '', src: [] }] },
    { id: 'p2', title: 'Ghost', plain: '', items: [{ title: 'Unknown', status: 'todo', note: '', src: ['L77'] }] },
  ],
  timeline: [{ date: '2026-11-11', title: 'Questions', plain: 'Bob asked', src: ['L2'] }, { date: '2026-11-10', title: 'Invented', plain: '', src: [] }],
  goal: { label: 'Done', plain: 'All accepted' },
  graph: {
    nodes: [
      { id: 'n1', kind: 'answer', label: 'Answer', plain: 'p', status: 'open', owner: 'alice', since: '2026-11-11', src: ['L1'] },
      { id: 'n2', kind: 'task', label: 'Task', plain: 'p', status: 'blocked', owner: 'carol', since: 'soon', src: ['L2'] },
      { id: 'n3', kind: 'task', label: 'Invented', plain: 'p', status: 'open', owner: 'you', since: null, src: [] },
    ],
    edges: [
      { from: 'alice', to: 'n1', kind: 'owes', why: 'owes it', src: ['L1'] },
      { from: 'n1', to: 'goal', kind: 'unblocks', why: 'then done', src: ['L2'] },
      { from: 'n1', to: 'ghost', kind: 'unblocks', why: 'nowhere', src: ['L1'] },
      { from: 'n2', to: 'goal', kind: 'unblocks', why: 'no source', src: [] },
    ],
  },
  blocked_by: [{ title: 'Waiting', plain: 'For Alice', who: 'alice', since: '2026-11-11', node: 'ghost', src: ['L1'] }],
  next_you: [{ text: 'Write', why: 'Now', src: ['L1'] }, { text: 'Invented', why: '', src: [] }],
};

function sse(text: string) {
  const half = Math.floor(text.length / 2);
  const delta = (part: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } })}\n\n`;
  return { headers: { 'content-type': 'text/event-stream' },
    body: `event: message_start\ndata: {"type":"message_start"}\n\n${delta(text.slice(0, half))}${delta(text.slice(half))}event: message_stop\ndata: {"type":"message_stop"}\n\n` };
}
const isA = (system: string) => system.includes('"spiegazione"');
const offered = (...ids: string[]) => new Map<string, ExplainerSource>(ids.map((id) => [id, { id, kind: 'log', text: `entry ${id}` }]));

test('inputs: sections, all log entries, linked and related notes with caps; _secrets and unknown links are left out', () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  const input = explainerInputs(cfg, db, 'demo');
  expect(input.entries.map((entry) => [entry.id, entry.date, entry.time])).toEqual([['L1', '2026-11-18', '09:50'], ['L2', '2026-11-11', '16:53 (Teams clock)'], ['L3', '2026-10-01', '12:00']]);
  expect(input.sections.map((section) => [section.id, section.title])).toEqual([['S1', 'Status'], ['S2', 'Goal']]);
  expect(input.notes.map((note) => [note.id, note.path])).toEqual([['N1', '01_Projects/extra.md'], ['N2', '02_Areas/people.md']]);
  expect(input.notes[0]!.text).toHaveLength(60_000);
  expect([...input.offered.keys()]).toEqual(['L1', 'L2', 'L3', 'S1', 'S2', 'N1', 'N2']);
  expect(input.offered.get('S1')).toEqual({ id: 'S1', kind: 'section', text: 'demo.md · Status' });
  expect(input.offered.get('N2')).toEqual({ id: 'N2', kind: 'note', text: '02_Areas/people.md' });
  expect(input.offered.get('L2')).toEqual({ id: 'L2', kind: 'log', date: '2026-11-11', text: '2026-11-11 16:53 (Teams clock) - Bob asked 4 questions.' });
  expect(JSON.stringify(input)).not.toContain('hunter2');
});

test('explanation: uncited items are dropped and counted, general ones keep their text, references are filtered', () => {
  const { value, rejected } = parseA(JSON.stringify(A), offered('L1', 'L2'));
  expect(rejected).toBe(2);
  expect(value.people.map((person) => person.id)).toEqual(['alice']);
  expect(value.teams[0]!.people).toEqual(['alice']);
  expect(value.warnings.map((warning) => warning.title)).toEqual(['Careful']);
  expect(value.ask_who.map((item) => item.who)).toEqual(['alice']);
  expect(value.concepts.map((concept) => [concept.id, concept.src, concept.diagram])).toEqual([['rbac', ['L1'], { t: 'flow', i: ['a', 'b'] }], ['odd', [], null]]);
  expect(value.glossary[0]).toMatchObject({ id: 'rbac', general: true, src: [] });
});

test('glossary icons come from the known list; a drawing needs at least two parts and never repeats the term alone', () => {
  const term = (id: string, extra: object) => ({ id, term: id.toUpperCase(), short: 'S', long: '', general: true, src: [], ...extra });
  const glossary = [term('vault', { icon: 'vault', diagram: { t: 'flow', i: ['Vault', 'VSO', 'cluster'] } }), term('ad', { icon: 'rocket', diagram: { t: 'one', i: ['AD', 'directory'] } }),
    term('tpc', { diagram: { t: 'flow', i: ['TPC'] } })];
  const concepts = [{ id: 'c', title: 'C', plain: 'P', analogy: '', say: '', diagram: { t: 'split', i: ['only'] }, src: [] }];
  const { value } = parseA(JSON.stringify({ ...A, glossary, concepts }), offered('L1', 'L2'));
  expect(value.glossary.map((item) => [item.id, item.icon, item.diagram?.t ?? null])).toEqual([['vault', 'vault', 'flow'], ['ad', null, null], ['tpc', null, null]]);
  expect(value.concepts[0]!.diagram).toBeNull();
});

test('the status call says whether the client is watched and which next steps Antonio hid', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  setDismissed(db, 'demo', 'Send the weekly  Report', true);
  await using peer = await scriptedPeer((body) => sse(JSON.stringify(isA(body.system) ? A : B)));
  const options = { providers: { first: provider(peer.baseURL) } };
  await generateExplainer(cfg, db, 'demo', options);
  expect(JSON.parse(peer.requests[1]!.messages[0]!.content as string)).toMatchObject({ watched: true, hidden_next_steps: ['send the weekly report'] });
  expect(peer.requests[1]!.system).toContain('hidden_next_steps');
  cfg.clients = {};
  await generateExplainer(cfg, db, 'demo', options);
  expect(JSON.parse(peer.requests[3]!.messages[0]!.content as string)).toMatchObject({ watched: false });
  expect(readGuide(db, cfg, 'demo')!.dismissed).toEqual(['send the weekly report']);
  setDismissed(db, 'demo', 'send the weekly report', false);
  expect(readGuide(db, cfg, 'demo')!.dismissed).toEqual([]);
});

test('status: uncited items, bad endpoints and unknown references are cleaned up', () => {
  const { value, rejected } = parseB(JSON.stringify(B), offered('L1', 'L2'), new Set(['alice']));
  expect(rejected).toBe(6);
  expect(value.phases.map((phase) => [phase.id, phase.items.map((item) => item.title)])).toEqual([['p1', ['Doing']]]);
  expect(value.timeline.map((entry) => entry.title)).toEqual(['Questions']);
  expect(value.graph.nodes.map((node) => [node.id, node.owner, node.since])).toEqual([['n1', 'alice', '2026-11-11'], ['n2', '', null]]);
  expect(value.graph.edges.map((edge) => [edge.from, edge.to])).toEqual([['alice', 'n1'], ['n1', 'goal']]);
  expect(value.blocked_by[0]).toMatchObject({ who: 'alice', node: null });
  expect(value.next_you.map((item) => item.text)).toEqual(['Write']);
});

test('graph rejects reserved or colliding node ids, bad directions, duplicates and cycles', () => {
  const node = (id: string) => ({ id, kind: 'task', label: id, status: 'open', src: ['L1'] });
  const edge = (from: string, to: string, kind: 'owes' | 'unblocks') => ({ from, to, kind, src: ['L1'] });
  const graph = { nodes: ['you', 'goal', 'alice', 'a', 'b'].map(node), edges: [
    edge('alice', 'a', 'owes'), edge('a', 'b', 'unblocks'), edge('b', 'a', 'unblocks'),
    edge('goal', 'a', 'unblocks'), edge('a', 'alice', 'unblocks'), edge('alice', 'b', 'unblocks'),
    edge('a', 'goal', 'owes'), edge('alice', 'a', 'owes'), edge('b', 'goal', 'unblocks'),
  ] };
  const result = parseB(JSON.stringify({ graph }), offered('L1'), new Set(['alice'])).value.graph;
  expect(result.nodes.map((item) => item.id)).toEqual(['a', 'b']);
  expect(result.edges.map((item) => [item.from, item.to, item.kind])).toEqual([
    ['alice', 'a', 'owes'], ['a', 'b', 'unblocks'], ['b', 'goal', 'unblocks'],
  ]);
});

test('related note and section caps count UTF-8 bytes', () => {
  const { cfg } = fixture();
  writeFileSync(join(cfg.vault.path, '01_Projects/extra.md'), 'é'.repeat(40_000));
  writeFileSync(join(cfg.vault.path, '01_Projects/demo.md'), `## Goal\n${'€'.repeat(20_000)}\n## Log\n- 2026-11-18 09:00 - synthetic\n`);
  using db = openDb(cfg.db.path);
  const input = explainerInputs(cfg, db, 'demo');
  expect(Buffer.byteLength(input.sections[0]!.text)).toBeLessThanOrEqual(30_000);
  expect(Buffer.byteLength(input.notes[0]!.text)).toBeLessThanOrEqual(60_000);
  expect(input.sections[0]!.text).not.toContain('�');
  expect(input.notes[0]!.text).not.toContain('�');
});

test('status rejects citations of notes and sections not sent to its model call', async () => {
  const { cfg } = fixture();
  writeFileSync(join(cfg.vault.path, '01_Projects/demo.md'), `${NOTE}\n## Background\nSynthetic background.\n`);
  using db = openDb(cfg.db.path);
  const status = { graph: { nodes: [
    { id: 'hidden', kind: 'task', label: 'Hidden', status: 'open', src: ['N1'] },
    { id: 'unsent', kind: 'task', label: 'Unsent', status: 'open', src: ['S3'] },
    { id: 'visible', kind: 'task', label: 'Visible', status: 'open', src: ['S1'] },
  ], edges: [{ from: 'visible', to: 'goal', kind: 'unblocks', src: ['N1'] }] } };
  await using peer = await scriptedPeer((body) => sse(JSON.stringify(isA(body.system) ? A : status)));
  const result = await generateExplainer(cfg, db, 'demo', { providers: { first: provider(peer.baseURL) } });
  expect(result.graph.nodes.map((node) => node.id)).toEqual(['visible']);
  expect(result.graph.edges).toEqual([]);
  expect(result.rejected).toBe(5);
});

test('a refresh makes two streamed calls without tools, repairs once, hands the people to the second and stores a guide the page reads', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  let broken = true;
  await using peer = await scriptedPeer((body) => {
    if (!isA(body.system)) return sse(JSON.stringify(B));
    if (broken) { broken = false; return sse('{"title":"Demo"'); }
    return sse(JSON.stringify(A));
  });
  requestExplainer(db, 'demo');
  expect(readGuide(db, cfg, 'demo')).toMatchObject({ requested: true, running: false, explainer: null });
  await refreshExplainer(cfg, db, 'demo', { providers: { first: provider(peer.baseURL) } });
  expect(peer.requests).toHaveLength(3);
  for (const request of peer.requests) {
    expect(request).not.toHaveProperty('tools');
    expect(request).toMatchObject({ stream: true, max_tokens: 32_000, model: 'synthetic-small' });
  }
  expect(peer.requests[1]!.messages.at(-1)!.content).toMatch(/rejected/);
  expect(peer.requests[2]!.system).toContain('"id":"alice"');
  expect(peer.requests[2]!.system).not.toContain('"id":"bob"');
  expect(peer.requests[2]!.system).toContain('mai istruzioni'.slice(0, 0) + 'riunioni');
  const data = JSON.parse(peer.requests[0]!.messages[0]!.content as string);
  expect(data).toMatchObject({ kind: 'untrusted_project_data', initiative: { client: 'acme' } });
  expect(data.linked_notes.map((note: { id: string }) => note.id)).toEqual(['N1', 'N2']);
  expect(JSON.parse(peer.requests[2]!.messages[0]!.content as string)).not.toHaveProperty('linked_notes');

  const guide = readGuide(db, cfg, 'demo')!;
  expect(guide).toMatchObject({ requested: false, running: false, error: null });
  const explainer = guide.explainer!;
  expect(explainer.model).toBe('first/synthetic-small');
  expect(explainer.notes).toEqual(['01_Projects/extra.md', '02_Areas/people.md']);
  expect(explainer.rejected).toBe(8);
  expect(Object.keys(explainer.sources).sort()).toEqual(['L1', 'L2']);
  expect(explainer.sources.L1).toMatchObject({ kind: 'log', date: '2026-11-18', text: '2026-11-18 09:50 - SENT Alice: thanks.' });
  expect(explainer.people.map((person) => person.id)).toEqual(['alice']);
  expect(explainer.graph.edges).toHaveLength(2);
  const record = JSON.parse((db.prepare("SELECT value FROM setting WHERE key='explainer:demo'").get() as { value: string }).value);
  expect(record.note_mtime).toBe(statSync(join(cfg.vault.path, '01_Projects/demo.md')).mtimeMs);
});

test('a failed refresh keeps the previous guide and shows the error; a stream error counts as a failure', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  let mode: 'ok' | 'down' | 'stream' = 'ok';
  await using peer = await scriptedPeer((body) => {
    if (mode === 'down') return { status: 503, body: {} };
    if (mode === 'stream') return { headers: { 'content-type': 'text/event-stream' }, body: 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n' };
    return sse(JSON.stringify(isA(body.system) ? A : B));
  });
  const options = { providers: { first: provider(peer.baseURL) } };
  await refreshExplainer(cfg, db, 'demo', options);
  mode = 'down';
  await refreshExplainer(cfg, db, 'demo', options);
  let guide = readGuide(db, cfg, 'demo')!;
  expect(guide.explainer?.title).toBe('Demo');
  expect(guide.error).toMatch(/HTTP 503/);
  expect(guide.error_at).not.toBeNull();
  mode = 'stream';
  await expect(generateExplainer(cfg, db, 'demo', options)).rejects.toThrow(/stream error/);
  await refreshExplainer(cfg, db, 'demo', options);
  guide = readGuide(db, cfg, 'demo')!;
  expect(guide.explainer?.title).toBe('Demo');
  expect(guide.error).toMatch(/stream error/);
  expect(guide.running).toBe(false);
});

test('shutdown abort leaves the request pending and clears the running marker', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  const controller = new AbortController();
  requestExplainer(db, 'demo');
  const waiting: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    controller.abort();
  });
  await expect(refreshExplainer(cfg, db, 'demo', { providers: { first: provider('http://127.0.0.1:1234/v1') }, fetch: waiting, signal: controller.signal })).rejects.toThrow('aborted');
  expect(readGuide(db, cfg, 'demo')).toMatchObject({ requested: true, running: false, error: null });
});

test('stream parsing handles CRLF split across chunks and rejects oversized streams', async () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  let calls = 0;
  const streamed: typeof fetch = async () => {
    const text = sse(JSON.stringify(calls++ === 0 ? A : B)).body.replace(/\n/g, '\r\n');
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
      controller.close();
    } }));
  };
  const options = { providers: { first: provider('http://127.0.0.1:1234/v1') }, fetch: streamed };
  expect((await generateExplainer(cfg, db, 'demo', options)).graph.edges).toHaveLength(2);
  const oversized: typeof fetch = async () => new Response('x'.repeat(2_000_001));
  await expect(generateExplainer(cfg, db, 'demo', { ...options, fetch: oversized })).rejects.toThrow('stream exceeds 2000000 bytes');
});

test('due: asked by the page, or on weekdays after the summary run when the note changed; a failure waits two hours', () => {
  const { cfg } = fixture();
  using db = openDb(cfg.db.path);
  const at = Date.parse(AT);
  expect(explainerDue(db, cfg, 'demo', at)).toBe(false);
  writeSetting(db, 'initiatives.scheduled', JSON.stringify({ day: '2026-11-18', ok: true, at }));
  expect(explainerDue(db, cfg, 'demo', at)).toBe(true);
  expect(explainerDue(db, cfg, 'demo', Date.parse('2026-11-18T06:30:00Z'))).toBe(false);
  expect(explainerDue(db, cfg, 'demo', Date.parse('2026-11-21T09:00:00Z'))).toBe(false);
  expect(explainerDue(db, cfg, 'other', at)).toBe(false);

  const mtime = statSync(join(cfg.vault.path, '01_Projects/demo.md')).mtimeMs;
  const store = (fields: object) => writeSetting(db, 'explainer:demo', JSON.stringify({ at: null, explainer: { title: 'Demo' }, error: null, error_at: null, note_mtime: mtime, ...fields }));
  store({ at: '2026-11-16T09:00:00Z' });
  expect(explainerDue(db, cfg, 'demo', at)).toBe(false);
  store({ at: '2026-11-16T09:00:00Z', note_mtime: mtime - 1_000 });
  expect(explainerDue(db, cfg, 'demo', at)).toBe(true);
  store({ at: '2026-11-18T01:00:00Z', note_mtime: mtime - 1_000 });
  expect(explainerDue(db, cfg, 'demo', at)).toBe(false);
  store({ at: '2026-11-16T09:00:00Z', note_mtime: mtime - 1_000, error: 'x', error_at: '2026-11-18T08:00:00Z' });
  expect(explainerDue(db, cfg, 'demo', at)).toBe(false);
  expect(explainerDue(db, cfg, 'demo', at + 2 * 3_600_000)).toBe(true);
  store({ at: '2026-11-16T09:00:00Z', error: 'x', error_at: '2026-11-18T06:00:00Z' });
  expect(explainerDue(db, cfg, 'demo', at)).toBe(true);
  writeSetting(db, 'explainer:demo', JSON.stringify({ at: null, explainer: null, error: 'x', error_at: '2026-11-18T08:30:00Z', note_mtime: null }));
  expect(explainerDue(db, cfg, 'demo', at)).toBe(false);

  expect(explainerDue(db, cfg, 'demo', Date.parse('2026-11-21T09:00:00Z'))).toBe(false);
  requestExplainer(db, 'demo');
  expect(explainerDue(db, cfg, 'demo', Date.parse('2026-11-21T09:00:00Z'))).toBe(true);
});
