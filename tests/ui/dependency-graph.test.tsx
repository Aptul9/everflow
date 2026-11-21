// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { DependencyGraph } from '../../src/components/initiatives/dependency-graph.tsx';
import type { Explainer, ExplainerEdge, ExplainerNode } from '../../src/lib/web-types.ts';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const node = (id: string): ExplainerNode => ({ id, kind: 'task', label: id, plain: `Dettaglio ${id}`, status: 'open', owner: 'alice', since: '2026-10-27', src: ['L1'] });
const edge = (from: string, to: string, kind: ExplainerEdge['kind']): ExplainerEdge => ({ from, to, kind, why: 'Motivo', src: ['L1'] });
function fixture(): Explainer {
  return {
    title: 'Acme', one_liner: '', why: [], role: '', teams: [], concepts: [], glossary: [], warnings: [], ask_who: [], phases: [], timeline: [], blocked_by: [], next_you: [], notes: [], rejected: 0, model: '',
    people: [{ id: 'alice', name: 'Alice', short: 'Alice', team: '', role: 'Responsabile', plain: '', ask_for: '', how: '', src: ['L1'] },
      { id: 'bob', name: 'Bob', short: 'Bob', team: '', role: '', plain: '', ask_for: '', how: '', src: ['L1'] }],
    goal: { label: 'Traguardo', plain: '' },
    graph: { nodes: ['uno', 'due', 'tre'].map(node), edges: [edge('alice', 'uno', 'owes'), edge('alice', 'due', 'owes'), edge('bob', 'uno', 'owes'), edge('uno', 'tre', 'unblocks'), edge('due', 'tre', 'unblocks'), edge('tre', 'goal', 'unblocks'), edge('due', 'goal', 'unblocks')] },
    sources: { L1: { id: 'L1', kind: 'log', text: 'Fonte acme' } },
  };
}

test('ports spread in sorted order, gutters stay wide and solid arrows end at borders', () => {
  const { container } = render(<DependencyGraph explainer={fixture()} today="2026-11-18" />);
  const graph = container.querySelector('[data-graph]')!;
  const item = (selector: string) => graph.querySelector<HTMLElement>(selector)!;
  const path = (id: string) => graph.querySelector<SVGPathElement>(`[data-edge="${id}"]`)!;
  const coords = (id: string) => path(id).getAttribute('d')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const alice = item('[data-person="alice"]'), uno = item('[data-node="uno"]');
  expect(parseFloat(uno.style.left) - (parseFloat(alice.style.left) + parseFloat(alice.style.width))).toBeGreaterThanOrEqual(96);
  const a = coords('alice>uno'), b = coords('bob>uno');
  expect(a[7]).not.toBe(b[7]);
  expect((a[7]! + b[7]!) / 2).toBe(parseFloat(uno.style.top) + parseFloat(uno.style.height) / 2);
  expect(Math.sign(a[7]! - b[7]!)).toBe(Math.sign(parseFloat(alice.style.top) - parseFloat(item('[data-person="bob"]').style.top)));
  const targetA = item('[data-node="uno"]'), targetB = item('[data-node="due"]');
  expect(Math.sign(coords('alice>uno')[1]! - coords('alice>due')[1]!)).toBe(Math.sign(parseFloat(targetA.style.top) - parseFloat(targetB.style.top)));
  const goal = item('[data-goal]');
  const goalA = coords('tre>goal'), goalB = coords('due>goal');
  expect(goalA.at(-1)).not.toBe(goalB.at(-1));
  expect((goalA.at(-1)! + goalB.at(-1)!) / 2).toBe(parseFloat(goal.style.top) + parseFloat(goal.style.height) / 2);
  for (const id of ['tre>goal', 'due>goal']) {
    const tail = path(id).nextElementSibling!;
    expect(tail.getAttribute('d')).toMatch(new RegExp(`H${parseFloat(goal.style.left)}$`));
    expect(tail.hasAttribute('stroke-dasharray')).toBe(false);
  }
  expect(graph.querySelector('marker')!.getAttribute('markerUnits')).toBe('userSpaceOnUse');
});

test('long edges use a gap through intermediate columns and columns fill available width', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1800);
  const { container } = render(<DependencyGraph explainer={fixture()} today="2026-11-18" />);
  const graph = container.querySelector<HTMLElement>('[data-graph]')!;
  expect(parseFloat(graph.style.width)).toBe(1800);
  const d = graph.querySelector('[data-edge="due>goal"]')!.getAttribute('d')!;
  const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  expect(d).toContain(' H');
  const tre = graph.querySelector<HTMLElement>('[data-node="tre"]')!;
  const y = nums[7]!;
  expect(y < parseFloat(tre.style.top) || y > parseFloat(tre.style.top) + parseFloat(tre.style.height)).toBe(true);
  expect(nums[8]! - nums[6]!).toBeGreaterThanOrEqual(228);
});

test('measured labels determine node and person sizes without truncation', () => {
  const rect = (width: number, height: number) => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-measure-name')) return rect(250, 16);
    if (this.hasAttribute('data-measure-person')) return rect(150, 42);
    if (this.hasAttribute('data-measure-node')) return rect(208, this.getAttribute('data-measure-node') === 'due' ? 56 : 14);
    return rect(0, 0);
  });
  const ex = fixture(); ex.people[0]!.name = 'Alice Smith with a long family name';
  const { container } = render(<DependencyGraph explainer={ex} today="2026-11-18" />);
  const person = container.querySelector<HTMLElement>('[data-person="alice"]')!;
  expect(person.style.width).toBe('220px');
  expect(person.style.height).toBe('58px');
  expect(person.textContent).toContain('Alice Smith with a long family name');
  expect(person.querySelector('.truncate')).toBeNull();
  expect(container.querySelector<HTMLElement>('[data-node="due"]')!.style.height).toBe('96px');
  expect(container.querySelector<HTMLElement>('[data-node="uno"]')!.style.height).toBe('64px');
});

test('person chains disclose individually, panel closes and focus resets', async () => {
  render(<DependencyGraph explainer={fixture()} today="2026-11-18" />);
  await userEvent.click(screen.getByRole('button', { name: /Alice: cosa aspetti/ }));
  const panel = screen.getByRole('complementary', { name: 'Spiegazione della catena' });
  const details = panel.querySelectorAll('details');
  expect(details).toHaveLength(2);
  expect(details[0]!.open).toBe(true);
  expect(details[1]!.open).toBe(false);
  expect(details[0]!.querySelector('summary')!.textContent).toMatch(/ · da \d+ gg/);
  await userEvent.click(details[1]!.querySelector('summary')!);
  expect(details[1]!.open).toBe(true);
  await userEvent.click(within(panel).getByRole('button', { name: 'Chiudi spiegazione' }));
  expect(screen.queryByRole('complementary')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Spiegazione' }));
  await userEvent.keyboard('{Escape}');
  expect(document.querySelector('[data-graph]')!.hasAttribute('data-focus')).toBe(false);
});

test('node lists all direct dependencies and unblocks, with Italian dates', async () => {
  render(<DependencyGraph explainer={fixture()} today="2026-11-18" />);
  await userEvent.click(document.querySelector('[data-node="due"]')!);
  const panel = screen.getByRole('complementary', { name: 'Spiegazione della catena' });
  expect(panel.textContent).toContain('dal 27/10');
  expect(panel.textContent).toContain('Da cosa dipende');
  expect(panel.textContent).toContain('Alice deve fare');
  expect(panel.textContent).toContain('Cosa sblocca');
  expect(panel.textContent).not.toContain('Fonte acme');
  const outgoing = within(panel).getByText('Cosa sblocca').closest('details')!;
  expect(outgoing.open).toBe(false);
  await userEvent.click(within(outgoing).getByText('Cosa sblocca'));
  expect(outgoing.textContent).toContain('tre');
  expect(outgoing.textContent).toContain('Traguardo');
});

test('panel avoids live items and falls below the graph when no corner fits', () => {
  let blocked = false;
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-graph-scroll')) return rect(100, 100, 800, 500);
    if (this.getAttribute('aria-label') === 'Spiegazione della catena') return rect(0, 0, 300, 200);
    if (this.getAttribute('data-person') === 'alice') return blocked ? rect(100, 100, 800, 500) : rect(120, 120, 100, 40);
    return rect(2000, 2000, 40, 40);
  });
  render(<DependencyGraph explainer={fixture()} today="2026-11-18" focus="alice" />);
  const panel = screen.getByRole('complementary', { name: 'Spiegazione della catena' });
  expect(panel.style.left).toBe('488px');
  fireEvent.click(within(panel).getByRole('button', { name: 'Chiudi spiegazione' }));
  const pill = screen.getByRole('button', { name: 'Spiegazione' });
  expect(pill.style.left).toBe('748px');
  fireEvent.click(pill);
  blocked = true;
  fireEvent(window, new Event('resize'));
  expect(screen.getByRole('complementary', { name: 'Spiegazione della catena' }).style.left).toBe('');
});

test('background click clears focus', async () => {
  render(<DependencyGraph explainer={fixture()} today="2026-11-18" />);
  const graph = document.querySelector<HTMLElement>('[data-graph]')!;
  await userEvent.click(graph.querySelector('[data-node="uno"]')!);
  expect(graph.getAttribute('data-focus')).toBe('uno');
  await userEvent.click(graph);
  expect(graph.hasAttribute('data-focus')).toBe(false);
});
