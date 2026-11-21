// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GuidePage } from '../../src/components/initiatives/guide-page.tsx';
import { Diagram } from '../../src/components/initiatives/diagram.tsx';
import type { Explainer, ExplainerDiagram, GuideState } from '../../src/lib/web-types.ts';

let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  window.localStorage.clear();
  fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json({ requested: true }) : Response.json(guide()));
  vi.stubGlobal('fetch', fetcher);
});

test('index visibility is remembered', async () => {
  render(<GuidePage {...props()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Nascondi indice' }));
  expect(screen.queryByRole('navigation', { name: 'Indice della guida' })).toBeNull();
  cleanup();
  render(<GuidePage {...props()} />);
  expect(screen.getByRole('button', { name: 'Mostra indice' })).toBeTruthy();
});

test('next steps dismiss optimistically and restore with text and token', async () => {
  render(<GuidePage {...props()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Nascondi questo passo' }));
  expect(screen.queryByText('Chase Alice')).toBeNull();
  expect(fetcher).toHaveBeenCalledWith('/api/guide/acme/dismiss', expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Chase Alice' }), headers: expect.objectContaining({ 'x-everflow-token': ACTION }) }));
  await userEvent.click(screen.getByRole('button', { name: 'Mostra nascosti (1)' }));
  await userEvent.click(screen.getByRole('button', { name: 'Ripristina' }));
  expect(fetcher).toHaveBeenCalledWith('/api/guide/acme/restore', expect.objectContaining({ body: JSON.stringify({ text: 'Chase Alice' }) }));
  expect(screen.getByRole('button', { name: 'Nascondi questo passo' })).toBeTruthy();
});

test('failed dismiss rolls back', async () => {
  fetcher.mockResolvedValue(new Response('', { status: 500 }));
  render(<GuidePage {...props()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Nascondi questo passo' }));
  await waitFor(() => expect(screen.getByText('Chase Alice')).toBeTruthy());
  expect(screen.getByRole('alert').textContent).toContain('HTTP 500');
});

test('dates and diagrams render as readable text', () => {
  render(<GuidePage {...props()} />);
  expect(screen.getByText('Guida · 18/11/2026')).toBeTruthy();
  expect(screen.getByText('1 novembre 2026')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Schema: A, B, C' })).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'Schema: OpenShift' })).toBeNull();
  expect(screen.queryByText('Frase da dire.')).toBeNull();
});

test('only drawings that show a relation are drawn, with every label', () => {
  for (const t of ['flow', 'nest', 'hub'] as const) {
    const { unmount } = render(<Diagram diagram={{ t, i: ['Long first label', 'Long second label'], hi: 1, b: 'Base' }} />);
    expect(screen.getByRole('img').textContent).toContain('Long first label');
    expect(screen.getByRole('img').textContent).toContain('Long second label');
    unmount();
  }
  for (const diagram of [{ t: 'one', i: ['A', 'B'] }, { t: 'split', i: ['A', 'B'] }, { t: 'row', i: ['A', 'B'] }, { t: 'hub', i: ['A', 'B'] }, { t: 'flow', i: ['A'] }] satisfies ExplainerDiagram[]) {
    const { container, unmount } = render(<Diagram diagram={diagram} />);
    expect(container.firstChild).toBeNull();
    unmount();
  }
  render(<Diagram diagram={{ t: 'flow', i: ['Job', 'Token', 'Safe'] }} />);
  expect(screen.getByRole('img').querySelectorAll('li')).toHaveLength(3);
  expect(screen.getByRole('img').querySelectorAll('.lucide-arrow-right')).toHaveLength(2);
});

test('initially hidden next steps can be restored', async () => {
  render(<GuidePage {...props(guide({ dismissed: ['chase alice'] }))} />);
  expect(screen.queryByText('Chase Alice')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Mostra nascosti (1)' }));
  await userEvent.click(screen.getByRole('button', { name: 'Ripristina' }));
  expect(screen.getByText('Chase Alice')).toBeTruthy();
});

test('failed restore returns the step to the hidden list', async () => {
  fetcher.mockResolvedValue(new Response('', { status: 500 }));
  render(<GuidePage {...props(guide({ dismissed: ['chase alice'] }))} />);
  await userEvent.click(screen.getByRole('button', { name: 'Mostra nascosti (1)' }));
  await userEvent.click(screen.getByRole('button', { name: 'Ripristina' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Ripristina' })).toBeTruthy());
  expect(screen.getByRole('alert').textContent).toContain('HTTP 500');
});

test('a stale poll cannot undo a dismissed step', async () => {
  vi.useFakeTimers();
  let resolvePoll!: (response: Response) => void;
  let resolvePost!: (response: Response) => void;
  fetcher.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
    if (init?.method === 'POST') resolvePost = resolve; else resolvePoll = resolve;
  }));
  render(<GuidePage {...props(guide({ requested: true }))} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  await act(async () => { screen.getByRole('button', { name: 'Nascondi questo passo' }).click(); });
  await act(async () => { resolvePost(Response.json({ dismissed: ['chase alice'] })); });
  await act(async () => { resolvePoll(Response.json(guide({ requested: true }))); });
  expect(screen.queryByText('Chase Alice')).toBeNull();
  expect(screen.getByRole('button', { name: 'Mostra nascosti (1)' })).toBeTruthy();
});

test('source popover shows each source once dated, cleaned of chat ids, staff ids and foreign dates, folded after the first', async () => {
  const ex = explainer();
  ex.why = ['Blocked since 11-19, see 2026-11-05.'];
  ex.sources.L1!.text = '2026-11-10 - Meeting chat 19:meeting_ABC123@thread.v2, Alice AGREED (owners Bob K IN22898516, Carol UK80132253) chase of 11-05 with `command`.';
  ex.sources.L2 = { id: 'L2', kind: 'section', text: 'acme-access.md · Weekly update (2026-09-08, 15:31)' };
  ex.concepts[0]!.src = ['L1', 'L2'];
  render(<GuidePage {...props(guide({ explainer: ex }))} />);
  expect(document.body.textContent).toContain('Blocked since 19/11, see 05/11/2026.');
  const card = screen.getByRole('article', { name: 'Access levels' });
  await userEvent.click(within(card).getByRole('button', { name: 'Fonti (2)' }));
  const popover = screen.getByRole('dialog');
  const text = popover.textContent!;
  expect(text.match(/10\/11\/2026/g)).toHaveLength(1);
  for (const bad of ['2026-11-10', '@thread', '19:meeting', 'IN22898516', 'UK80132253', '11-05', '.md', 'Mostra tutto']) expect(text).not.toContain(bad);
  expect(text).toContain('Alice AGREED (owners Bob K, Carol) chase of 05/11');
  expect(popover.querySelector('code')?.textContent).toBe('command');
  const folds = [...popover.querySelectorAll<HTMLElement>('[data-fold]')];
  expect(folds.map((fold) => fold.dataset.open ?? 'closed')).toEqual(['true', 'closed']);
  expect(folds[1]!.textContent).toContain('Nota del progetto');
  expect(folds[1]!.textContent).toContain('Weekly update (08/09/2026, 15:31)');
  await userEvent.click(within(folds[1]!).getByRole('button'));
  expect(folds[1]!.dataset.open).toBe('true');
  expect(within(card).queryByText(/AGREED/)).toBeNull();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const ACTION = 'a'.repeat(64);
const src = (id: string, text: string) => ({ id, kind: 'log' as const, date: '2026-11-10', text });

function explainer(): Explainer {
  return {
    title: 'Acme access project', one_liner: 'We give Acme a safe way into OpenShift.', why: ['Acme needs a standard login path for OpenShift.'], role: 'You verify the controls.',
    teams: [{ id: 'iam', name: 'Acme IAM', plain: 'Owns the access rules.', kind: 'client', people: ['alice', 'bob'] }],
    people: [
      { id: 'alice', name: 'Alice Smith', short: 'Smith', team: 'iam', role: 'Owner of the controls', plain: 'Alice decides the standard.', ask_for: 'Decisions', how: 'Teams', src: ['L1'] },
      { id: 'bob', name: 'Bob Jones', short: 'Jones', team: 'iam', role: 'Platform engineer', plain: 'Bob runs the cluster.', ask_for: 'Access', how: 'Email', src: [] },
    ],
    concepts: [{ id: 'access', title: 'Access levels', plain: 'Four levels of access.', analogy: 'Keys of a house.', say: 'Escalation is the routine path.', diagram: { t: 'flow', i: ['A', 'B', 'C'], hi: 1 }, src: ['L1'] }],
    glossary: [
      { id: 'openshift', term: 'OpenShift', aliases: ['OCP'], short: 'Red Hat Kubernetes platform.', long: 'The base of the cloud.', diagram: { t: 'one', i: ['OpenShift'] }, general: true, src: [] },
      { id: 'sso', term: 'SSO', aliases: [], short: 'One login for everything.', long: '', diagram: null, general: true, src: [] },
    ],
    warnings: [{ title: 'Standard not approved', text: 'The standard is still pending.', src: ['L1'] }],
    ask_who: [{ need: 'A decision on scope', who: 'alice', how: 'Teams' }],
    phases: [{ id: 'p1', title: 'Discovery', plain: 'Understand the setup.', items: [
      { title: 'Read the standard', status: 'done', note: '', src: ['L1'] }, { title: 'Verify controls', status: 'doing', note: 'Half done', src: [] }, { title: 'Report', status: 'todo', note: '', src: [] }] }],
    timeline: [{ date: '2026-11-01', title: 'Kickoff', plain: 'Project started.', src: ['L1'] }],
    goal: { label: 'Controls verified', plain: 'All controls checked.' },
    graph: {
      nodes: [
        { id: 'answers', kind: 'answer', label: 'Answers to the questions', plain: 'Four open questions.', status: 'blocked', owner: 'alice', since: '2026-11-02', src: ['L1'] },
        { id: 'review', kind: 'task', label: 'Review of the standard', plain: 'Read it fully.', status: 'open', owner: 'bob', since: null, src: [] },
        { id: 'draft', kind: 'deliverable', label: 'Draft report', plain: 'First report.', status: 'open', owner: 'you', since: '2026-11-10', src: [] },
      ],
      edges: [
        { from: 'alice', to: 'answers', kind: 'owes', why: 'Alice has not answered', src: ['L1'] },
        { from: 'bob', to: 'review', kind: 'owes', why: 'Bob owes the review', src: ['L1'] },
        { from: 'you', to: 'draft', kind: 'owes', why: 'You owe the draft', src: ['L1'] },
        { from: 'answers', to: 'draft', kind: 'unblocks', why: 'Answers feed the draft', src: ['L1'] },
        { from: 'draft', to: 'goal', kind: 'unblocks', why: 'The draft closes the work', src: ['L1'] },
        { from: 'review', to: 'goal', kind: 'unblocks', why: 'The review closes the work', src: ['L1'] },
      ],
    },
    blocked_by: [{ title: 'Answers missing', plain: 'Four questions are open.', who: 'alice', since: '2026-11-02', node: 'answers', src: ['L1'] }],
    next_you: [{ text: 'Chase Alice', why: 'Nothing moves without her', src: [] }],
    sources: { L1: src('L1', '2026-11-10 09:00 - Alice: standard pending') },
    notes: ['02_Areas/x.md'], rejected: 2, model: 'm1',
  };
}

function guide(fields: Partial<GuideState> = {}): GuideState {
  return {
    initiative: { id: 'acme', title: 'Acme access', client: 'acme', note: '01_Projects/acme.md', at: '2026-11-18T07:00:00.000000Z', error: null, error_at: null,
      summary: { state: 'waiting_them', headline: 'Alice silent on 4 questions', now: [], waits: [], next: [], done: [], rejected: 0, entries: 5, model: 'm' } },
    today: '2026-11-18', at: '2026-11-18T07:00:00.000000Z', explainer: explainer(), error: null, error_at: null, requested: false, running: false, providers: true, dismissed: [], ...fields,
  };
}

const props = (state = guide()) => ({ id: 'acme', initialState: state, token: ACTION });

test('sections render with anchors and the one-liner', () => {
  render(<GuidePage {...props()} />);
  for (const id of ['breve', 'perche', 'ruolo', 'chi', 'concetti', 'punto', 'blocchi', 'storia', 'chiedere', 'attenzione', 'glossario']) expect(document.getElementById(id), id).not.toBeNull();
  expect(document.getElementById('breve')!.textContent).toContain('We give Acme a safe way into OpenShift.');
  expect(screen.getByRole('region', { name: 'Cosa blocca e sblocca' })).toBeTruthy();
  expect(screen.getByRole('article', { name: 'Discovery' }).textContent).toContain('1/3');
  expect(screen.getByRole('progressbar', { name: 'Avanzamento Discovery' }).getAttribute('aria-valuenow')).toBe('33');
});

test('a glossary term in prose is linked, shows its short text on hover and jumps to the entry', async () => {
  render(<GuidePage {...props()} />);
  const term = within(document.getElementById('perche')!).getByRole('button', { name: 'OpenShift' });
  await userEvent.hover(term);
  expect(screen.getByRole('tooltip').textContent).toContain('Red Hat Kubernetes platform.');
  await userEvent.unhover(term);
  expect(screen.queryByRole('tooltip')).toBeNull();
  await userEvent.click(term);
  await waitFor(() => expect(document.getElementById('g-openshift')!.getAttribute('data-highlight')).toBe('true'));
  expect(screen.getAllByRole('button', { name: /torna dove eri/i }).length).toBeGreaterThan(0);
});

test('clicking a person in the graph fades the unrelated nodes and lists the chain to the goal; Esc resets', async () => {
  render(<GuidePage {...props()} />);
  const graph = document.querySelector('[data-graph]') as HTMLElement;
  expect(graph.querySelectorAll('[data-dim="true"]')).toHaveLength(0);
  await userEvent.click(within(graph).getByRole('button', { name: /Alice Smith/ }));
  expect(graph.querySelector('[data-node="review"]')!.getAttribute('data-dim')).toBe('true');
  expect(graph.querySelector('[data-person="bob"]')!.getAttribute('data-dim')).toBe('true');
  expect(graph.querySelector('[data-node="answers"]')!.getAttribute('data-dim')).toBeNull();
  expect(graph.querySelector('[data-node="draft"]')!.getAttribute('data-dim')).toBeNull();
  expect(graph.querySelector('[data-goal]')!.getAttribute('data-dim')).toBeNull();
  const panel = screen.getByRole('complementary', { name: 'Spiegazione della catena' });
  expect(panel.textContent).toContain('Alice Smith deve rispondere');
  expect(panel.textContent).toContain('Answers to the questions');
  expect(panel.textContent).toContain('Questo sblocca «Draft report»');
  expect(panel.textContent).toContain('Questo sblocca il traguardo: Controls verified');
  expect(panel.textContent).toContain('Answers feed the draft');
  await userEvent.keyboard('{Escape}');
  expect(graph.querySelectorAll('[data-dim="true"]')).toHaveLength(0);
});

test('clicking a node highlights what it waits on and what it unblocks; the same node again resets', async () => {
  render(<GuidePage {...props()} />);
  const graph = document.querySelector('[data-graph]') as HTMLElement;
  await userEvent.click(graph.querySelector('[data-node="draft"]')!);
  expect(graph.querySelector('[data-node="answers"]')!.getAttribute('data-dim')).toBeNull();
  expect(graph.querySelector('[data-person="alice"]')!.getAttribute('data-dim')).toBeNull();
  expect(graph.querySelector('[data-node="review"]')!.getAttribute('data-dim')).toBe('true');
  await userEvent.click(graph.querySelector('[data-node="draft"]')!);
  expect(graph.querySelectorAll('[data-dim="true"]')).toHaveLength(0);
});

test('a person card opens from the team map and its button focuses the graph on them', async () => {
  render(<GuidePage {...props()} />);
  await userEvent.click(within(document.getElementById('chi')!).getByRole('button', { name: 'Bob Jones' }));
  const card = screen.getByRole('complementary', { name: 'Scheda di Bob Jones' });
  expect(card.textContent).toContain('Bob runs the cluster.');
  expect(card.textContent).toContain('Review of the standard');
  await userEvent.click(within(card).getByRole('button', { name: 'Mostra cosa aspetto da lui' }));
  const graph = document.querySelector('[data-graph]') as HTMLElement;
  expect(graph.getAttribute('data-focus')).toBe('bob');
  expect(graph.querySelector('[data-person="alice"]')!.getAttribute('data-dim')).toBe('true');
});

test('uncited edges and cycles do not create dependencies', async () => {
  const ex = explainer();
  ex.graph.edges = [
    { from: 'alice', to: 'answers', kind: 'owes', why: 'Uncited', src: [] },
    { from: 'answers', to: 'draft', kind: 'unblocks', why: 'Supported', src: ['L1'] },
    { from: 'draft', to: 'answers', kind: 'unblocks', why: 'Cycle', src: ['L1'] },
  ];
  render(<GuidePage {...props(guide({ explainer: ex }))} />);
  await userEvent.click(within(document.getElementById('chi')!).getByRole('button', { name: 'Alice Smith' }));
  await userEvent.click(within(screen.getByRole('complementary', { name: 'Scheda di Alice Smith' })).getByRole('button', { name: 'Mostra cosa aspetto da lui' }));
  expect(screen.getByRole('complementary', { name: 'Spiegazione della catena' }).textContent).toContain('Nessuna dipendenza documentata');
  expect(document.querySelector('[data-edge="alice>answers"]')).toBeNull();
  expect(document.querySelector('[data-edge="draft>answers"]')).toBeNull();
});

test('a person with no graph nodes still gets an explicit unknown dependency state', async () => {
  const ex = explainer();
  ex.graph = { nodes: [], edges: [] };
  render(<GuidePage {...props(guide({ explainer: ex }))} />);
  await userEvent.click(within(document.getElementById('chi')!).getByRole('button', { name: 'Alice Smith' }));
  await userEvent.click(within(screen.getByRole('complementary', { name: 'Scheda di Alice Smith' })).getByRole('button', { name: 'Mostra cosa aspetto da lui' }));
  expect(screen.getByRole('complementary', { name: 'Spiegazione della catena' }).textContent).toContain('Nessuna dipendenza documentata');
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('complementary', { name: 'Spiegazione della catena' }).textContent).toContain('Scegli una persona');
});

test('Rigenera la guida posts with the token, then polls while the run is pending', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetcher.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json({ requested: true }) : Response.json(guide({ requested: true })));
  render(<GuidePage {...props()} />);
  await act(async () => { screen.getByRole('button', { name: 'Rigenera la guida' }).click(); });
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/guide/acme/regenerate', expect.objectContaining({ method: 'POST', body: '{}',
    headers: expect.objectContaining({ 'x-everflow-token': ACTION, 'content-type': 'application/json' }) })));
  expect(screen.getAllByRole('button', { name: 'In preparazione...' })[0]!.hasAttribute('disabled')).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher).toHaveBeenCalledWith('/api/guide/acme', expect.objectContaining({ cache: 'no-store' }));
});

test('regeneration stays disabled until the request is acknowledged', async () => {
  let resolve!: (response: Response) => void;
  fetcher.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
  render(<GuidePage {...props()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Rigenera la guida' }));
  expect(screen.getByRole('button', { name: 'In preparazione...' }).hasAttribute('disabled')).toBe(true);
  await act(async () => { resolve(Response.json({ requested: true })); });
  expect(screen.getByRole('button', { name: 'In preparazione...' }).hasAttribute('disabled')).toBe(true);
});

test('without a guide the page says it is being prepared and still shows the summary', () => {
  render(<GuidePage {...props(guide({ explainer: null, at: null }))} />);
  const empty = screen.getByRole('region', { name: 'Guida in preparazione' });
  expect(empty.textContent).toContain('Alice silent on 4 questions');
  expect(empty.textContent).toContain('non è ancora stata preparata');
  expect(within(empty).getByRole('button', { name: 'Prepara la guida' })).toBeTruthy();
  cleanup();
  render(<GuidePage {...props(guide({ explainer: null, at: null, requested: true }))} />);
  expect(screen.getByRole('region', { name: 'Guida in preparazione' }).textContent).toContain('La guida è in preparazione.');
  expect(screen.queryByRole('button', { name: 'Prepara la guida' })).toBeNull();
});

test('a failed run shows the error above the previous guide', () => {
  render(<GuidePage {...props(guide({ error: 'Provider HTTP 503', error_at: '2026-11-18T07:05:00.000000Z' }))} />);
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('Ultima preparazione fallita');
  expect(alert.textContent).toContain('Provider HTTP 503');
  expect(document.getElementById('breve')).not.toBeNull();
});
