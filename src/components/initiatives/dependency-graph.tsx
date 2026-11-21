'use client';

import { Flag, GripHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Explainer, ExplainerEdge, ExplainerNode } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Glossed } from './glossed.tsx';
import { FlagButton, Fold, GuideSources } from './sources.tsx';

const NODE_W = 228, PERSON_MIN = 168, PERSON_MAX = 220, GOAL_W = 176, GOAL_H = 88, GUTTER = 96, GAP = 14, PAD = 14;

export function workDays(since: string | null, today: string): number {
  if (!since) return 0;
  const day = new Date(`${since.slice(0, 10)}T00:00:00Z`), end = new Date(`${today.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || Number.isNaN(end.getTime())) return 0;
  let count = 0;
  for (let guard = 0; day < end && guard < 4000; guard++) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getUTCDay() % 6 !== 0) count++;
  }
  return count;
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

interface Item { id: string; type: 'person' | 'node' | 'goal'; col: number; x: number; y: number; w: number; h: number }

function layout(g: Explainer, available: number, personWidth: number, heights: Record<string, number>) {
  const nodes = g.graph.nodes, ids = new Set(nodes.map((node) => node.id));
  const people = new Set(['you', ...g.people.map((person) => person.id)]);
  const edges: ExplainerEdge[] = [];
  for (const edge of g.graph.edges) {
    const valid = edge.kind === 'owes' ? people.has(edge.from) && ids.has(edge.to)
      : ids.has(edge.from) && (ids.has(edge.to) || edge.to === 'goal');
    if (!valid || edge.from === edge.to || !edge.src.some((id) => !!g.sources[id])) continue;
    if (edges.some((item) => item.from === edge.from && item.to === edge.to)) continue;
    if (reach(edges, edge.to, false, true).ids.has(edge.from)) continue;
    edges.push(edge);
  }
  const persons: string[] = [];
  for (const edge of edges) if (!ids.has(edge.from) && !persons.includes(edge.from)) persons.push(edge.from);
  persons.sort((a, b) => a === 'you' ? -1 : b === 'you' ? 1 : 0);
  const layer = new Map(nodes.map((node) => [node.id, 1]));
  for (let round = 0; round < nodes.length; round++) {
    let changed = false;
    for (const edge of edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
      if (layer.get(edge.from)! + 1 > layer.get(edge.to)!) { layer.set(edge.to, layer.get(edge.from)! + 1); changed = true; }
    }
    if (!changed) break;
  }
  const goalCol = Math.max(1, ...layer.values()) + 1;
  const cols: string[][] = Array.from({ length: goalCol + 1 }, () => []);
  cols[0] = persons;
  for (const node of nodes) cols[layer.get(node.id)!]!.push(node.id);
  cols[goalCol] = ['goal'];
  const virtual = new Set<string>(), routes = new Map<ExplainerEdge, string[]>(), segments: { from: string; to: string }[] = [];
  edges.forEach((edge, index) => {
    const from = ids.has(edge.from) ? layer.get(edge.from)! : 0, to = edge.to === 'goal' ? goalCol : layer.get(edge.to)!;
    const route = [edge.from];
    for (let c = from + 1; c < to; c++) { const id = `\0${index}:${c}`; virtual.add(id); cols[c]!.push(id); route.push(id); }
    route.push(edge.to); routes.set(edge, route);
    for (let i = 1; i < route.length; i++) segments.push({ from: route[i - 1]!, to: route[i]! });
  });
  const kind = (id: string): Item['type'] => id === 'goal' ? 'goal' : ids.has(id) ? 'node' : 'person';
  const size = (id: string) => virtual.has(id) ? [0, 4] as const : kind(id) === 'goal' ? [GOAL_W, GOAL_H] as const : kind(id) === 'node' ? [NODE_W, heights[`node:${id}`] ?? 84] as const : [personWidth, heights[`person:${id}`] ?? 44] as const;
  const widths = cols.map((_, c) => c === 0 ? personWidth : c === goalCol ? GOAL_W : NODE_W);
  const gutter = Math.max(GUTTER, (available - PAD * 2 - widths.reduce((a, b) => a + b, 0)) / goalCol);
  const xs = widths.map((_, c) => PAD + widths.slice(0, c).reduce((a, b) => a + b, 0) + c * gutter);
  const centers = new Map<string, number>();
  const height = () => Math.max(...cols.map((col) => col.reduce((sum, id) => sum + size(id)[1] + GAP, -GAP)));
  const place = () => {
    const total = height();
    for (const col of cols) {
      let top = (total - col.reduce((sum, id) => sum + size(id)[1] + GAP, -GAP)) / 2;
      for (const id of col) { centers.set(id, top + size(id)[1] / 2); top += size(id)[1] + GAP; }
    }
  };
  place();
  const average = (id: string, forward: boolean) => {
    const ys = segments.filter((edge) => forward ? edge.to === id : edge.from === id).map((edge) => centers.get(forward ? edge.from : edge.to)!).filter((y) => y !== undefined);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : centers.get(id)!;
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let c = 1; c < goalCol; c++) { cols[c]!.sort((a, b) => average(a, true) - average(b, true)); place(); }
    for (let c = goalCol - 1; c >= 0; c--) { cols[c]!.sort((a, b) => average(a, false) - average(b, false)); place(); }
  }
  const total = height();
  const items = new Map<string, Item>();
  cols.forEach((col, c) => col.forEach((id) => {
    const [w, h] = size(id);
    if (!virtual.has(id)) items.set(id, { id, type: kind(id), col: c, x: xs[c]!, y: PAD + centers.get(id)! - h / 2, w, h });
  }));
  const waypoints = new Map<ExplainerEdge, { left: number; right: number; y: number }[]>();
  for (const [edge, route] of routes) waypoints.set(edge, route.slice(1, -1).map((id) => {
    const c = cols.findIndex((col) => col.includes(id));
    return { left: xs[c]!, right: xs[c]! + widths[c]!, y: PAD + centers.get(id)! };
  }));
  const ports = new Map<ExplainerEdge, { from: number; to: number }>();
  for (const item of items.values()) {
    for (const side of ['from', 'to'] as const) {
      const connected = edges.filter((edge) => edge[side] === item.id).sort((a, b) => {
        const other = side === 'from' ? 'to' : 'from';
        const aa = items.get(a[other])!, bb = items.get(b[other])!;
        return aa.y + aa.h / 2 - bb.y - bb.h / 2 || a[other].localeCompare(b[other]);
      });
      const spacing = Math.min(12, (item.h - 16) / Math.max(1, connected.length - 1));
      connected.forEach((edge, i) => {
        const port = ports.get(edge) ?? { from: 0, to: 0 };
        port[side] = item.y + item.h / 2 + (i - (connected.length - 1) / 2) * spacing;
        ports.set(edge, port);
      });
    }
  }
  return { items, edges, ports, waypoints, width: PAD * 2 + widths.reduce((a, b) => a + b, 0) + goalCol * gutter, height: total + PAD * 2 };
}

function reach(edges: ExplainerEdge[], start: string, up: boolean, down: boolean) {
  const ids = new Set([start]), used = new Set<ExplainerEdge>();
  const walk = (forward: boolean) => {
    const queue = [start], seen = new Set(queue);
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of edges) {
        const next = forward ? edge.from === current ? edge.to : null : edge.to === current ? edge.from : null;
        if (next === null) continue;
        used.add(edge); ids.add(next);
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
  };
  if (down) walk(true);
  if (up) walk(false);
  return { ids, used };
}

// Shortest chain of edges from a node to the goal; the direct next steps when the goal is not reachable
function pathToGoal(edges: ExplainerEdge[], start: string): ExplainerEdge[] {
  const via = new Map<string, ExplainerEdge>(), queue = [start], seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift()!;
    if (current === 'goal') break;
    for (const edge of edges) if (edge.from === current && !seen.has(edge.to)) { seen.add(edge.to); via.set(edge.to, edge); queue.push(edge.to); }
  }
  if (!via.has('goal')) return edges.filter((edge) => edge.from === start).slice(0, 1);
  const out: ExplainerEdge[] = [];
  for (let at = 'goal'; at !== start; at = via.get(at)!.from) out.unshift(via.get(at)!);
  return out;
}

const verbs: Record<ExplainerNode['kind'], [string, string]> = {
  task: ['deve fare', 'Devi fare'], deliverable: ['deve consegnare', 'Devi consegnare'], decision: ['deve decidere', 'Devi decidere'], answer: ['deve rispondere', 'Devi rispondere'],
};
const statusText = { open: 'aperto', blocked: 'bloccato', done: 'fatto' } as const;
const statusTone = {
  open: 'border-info bg-card', blocked: 'border-destructive bg-destructive-soft', done: 'border-success bg-success-soft opacity-60',
} as const;

function Step(props: { n: number; children: React.ReactNode; why?: string; src?: string[]; sources: Explainer['sources'] }) {
  return <li className="flex gap-2.5">
    <span aria-hidden="true" className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{props.n}</span>
    <span className="min-w-0 text-sm leading-snug">
      <span className="font-medium">{props.children}</span>
      {props.why && <span className="mt-0.5 block text-[13px] text-muted-foreground"><Glossed text={props.why} /></span>}
      {props.src && <GuideSources ids={props.src} sources={props.sources} />}{props.why && <FlagButton text={props.why} />}
    </span>
  </li>;
}


export function DependencyGraph(props: { explainer: Explainer; today: string; focus?: string | null; onFocusChange?: (id: string | null) => void; className?: string }) {
  const { explainer, today, onFocusChange } = props;
  const [selected, setSelected] = useState<string | null>(props.focus ?? null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  const [available, setAvailable] = useState(0), [personWidth, setPersonWidth] = useState(PERSON_MIN);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const frameRef = useRef<HTMLDivElement>(null), scrollRef = useRef<HTMLDivElement>(null), panelRef = useRef<HTMLElement>(null), pillRef = useRef<HTMLButtonElement>(null), measureRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setSelected(props.focus ?? null); if (props.focus) setPanelOpen(true); }, [props.focus]);
  useEffect(() => {
    const scroll = scrollRef.current, measure = measureRef.current;
    if (!scroll || !measure) return;
    const update = () => {
      setAvailable(scroll.clientWidth);
      const names = [...measure.querySelectorAll<HTMLElement>('[data-measure-name]')];
      const width = Math.min(PERSON_MAX, Math.max(PERSON_MIN, ...names.map((el) => Math.ceil(el.getBoundingClientRect().width) + 56)));
      setPersonWidth(width);
      const next: Record<string, number> = {};
      for (const el of measure.querySelectorAll<HTMLElement>('[data-measure-node]')) next[`node:${el.dataset.measureNode}`] = Math.max(64, Math.ceil(el.getBoundingClientRect().height) + 40);
      for (const el of measure.querySelectorAll<HTMLElement>('[data-measure-person]')) next[`person:${el.dataset.measurePerson}`] = Math.max(40, Math.ceil(el.getBoundingClientRect().height) + 16);
      setHeights((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update); observer?.observe(scroll);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [explainer, personWidth]);
  const lay = useMemo(() => layout(explainer, available, personWidth, heights), [explainer, available, personWidth, heights]);
  const people = useMemo(() => new Map(explainer.people.map((person) => [person.id, person])), [explainer]);
  const nodes = useMemo(() => new Map(explainer.graph.nodes.map((node) => [node.id, node])), [explainer]);
  const sel = selected && (lay.items.has(selected) || selected === 'you' || people.has(selected)) && selected !== 'goal' ? selected : null;
  const selType = sel ? lay.items.get(sel)?.type ?? 'person' : null;
  const trace = useMemo(() => sel ? reach(lay.edges, sel, selType === 'node', true) : null, [lay, sel, selType]);
  const choose = (id: string | null) => { setSelected(id); if (id) setPanelOpen(true); onFocusChange?.(id); };
  useEffect(() => {
    if (!sel) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSelected(null); onFocusChange?.(null); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [sel, onFocusChange]);
  const nameOf = (id: string) => id === 'you' ? 'Tu' : id === 'goal' ? explainer.goal.label : people.get(id)?.name ?? nodes.get(id)?.label ?? id;
  const labelOf = (id: string) => id === 'goal' ? explainer.goal.label : nodes.get(id)?.label ?? id;
  const dim = (id: string) => !!trace && !trace.ids.has(id);
  const edgeDim = (edge: ExplainerEdge) => !!trace && !trace.used.has(edge);
  const waited = (node: ExplainerNode) => { const days = workDays(node.since, today); return node.since && node.status !== 'done' ? `da ${days} gg` : ''; };

  // Placed once per selection where it covers the fewest highlighted boxes and lines, inside the visible part of the graph;
  // after a drag it stays where it was put. Opening a fold never moves it.
  useEffect(() => {
    const scroll = scrollRef.current, panel = panelRef.current;
    if (!sel || !scroll) { setPanelPosition(null); return; }
    if (!panelOpen || !panel) return;
    const update = () => {
      if (window.innerWidth < 640) { setPanelPosition(null); return; }
      if (placed) { setPanelPosition((old) => old?.left === placed.left && old?.top === placed.top ? old : placed); return; }
      const box = scroll.getBoundingClientRect(), p = panel.getBoundingClientRect(), margin = 12;
      const w = p.width, h = Math.min(p.height, window.innerHeight * 0.75);
      const top = Math.max(margin, -box.top + margin), bottom = Math.min(box.height, window.innerHeight - box.top) - margin;
      const span = (from: number, to: number) => { const out: number[] = []; for (let v = from; v < to; v += 24) out.push(v); out.push(Math.max(from, to)); return out; };
      const xs = span(margin, box.width - w - margin), ys = span(top, bottom - h);
      const live = [...scroll.querySelectorAll<HTMLElement>('[data-node]:not([data-dim]), [data-person]:not([data-dim]), [data-goal]:not([data-dim])')].map((item) => {
        const r = item.getBoundingClientRect(), chosen = item.getAttribute('aria-pressed') === 'true';
        return { left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top, weight: chosen ? 10_000 : 100 };
      });
      const paths = [...scroll.querySelectorAll<SVGPathElement>('[data-edge][data-live]')].flatMap((path) => [path, path.nextElementSibling as SVGPathElement]);
      const points = paths.flatMap((path) => {
        if (typeof path?.getTotalLength !== 'function') return [];
        const rect = path.ownerSVGElement!.getBoundingClientRect(), length = path.getTotalLength(), out: { x: number; y: number }[] = [];
        for (let i = 0; i <= Math.ceil(length / 12); i++) { const pt = path.getPointAtLength(Math.min(length, i * 12)); out.push({ x: rect.left + pt.x - box.left, y: rect.top + pt.y - box.top }); }
        return out;
      });
      let best = { left: xs.at(-1)!, top: ys[0]!, score: Infinity };
      for (const x of [...xs].reverse()) for (const y of ys) {
        const right = x + w, low = y + h;
        let score = 0;
        for (const r of live) if (r.right > x - 6 && r.left < right + 6 && r.bottom > y - 6 && r.top < low + 6) score += r.weight;
        if (score >= best.score) continue;
        for (const pt of points) if (pt.x >= x - 4 && pt.x <= right + 4 && pt.y >= y - 4 && pt.y <= low + 4) score++;
        if (score < best.score) best = { left: x, top: y, score };
      }
      const next = { left: Math.max(0, best.left), top: Math.max(0, best.top) };
      setPanelPosition((old) => old?.left === next.left && old?.top === next.top ? old : next);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [lay, sel, panelOpen, placed]);  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    const frame = frameRef.current, panel = panelRef.current ?? pillRef.current;
    if (!panelPosition || !frame || !panel || (event.target as Element).closest('button')) return;
    event.preventDefault();
    const handle = event.currentTarget, box = frame.getBoundingClientRect(), start = { x: event.clientX, y: event.clientY, ...panelPosition };
    handle.setPointerCapture?.(event.pointerId);
    const move = (e: PointerEvent) => setPlaced({
      left: Math.max(0, Math.min(start.left + e.clientX - start.x, box.width - panel.offsetWidth)),
      top: Math.max(0, Math.min(start.top + e.clientY - start.y, box.height - 48)),
    });
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  };

  const chain = (edge: ExplainerEdge, first: number) => {
    const steps: React.ReactNode[] = [];
    const node = nodes.get(edge.to);
    if (node) {
      const verb = verbs[node.kind][edge.from === 'you' ? 1 : 0];
      steps.push(<Step key="own" n={first} why={edge.why} src={edge.src} sources={explainer.sources}>
        {edge.from === 'you' ? `${verb}: ` : `${nameOf(edge.from)} ${verb}: `}«{node.label}»</Step>);
      const onward = pathToGoal(lay.edges, node.id);
      onward.forEach((next, index) => {
        steps.push(<Step key={`${next.from}-${next.to}`} n={first + 1 + index} why={next.why} src={next.src} sources={explainer.sources}>
          {next.to === 'goal' ? <>Questo sblocca il traguardo: {explainer.goal.label}</> : <>Questo sblocca «{labelOf(next.to)}»</>}</Step>);
      });
      if (onward.at(-1)?.to !== 'goal') steps.push(<li key="unknown" className="text-sm text-muted-foreground">Nessun collegamento successivo al traguardo documentato.</li>);
    }
    return steps;
  };

  let panel: React.ReactNode;
  if (!sel) {
    panel = <p className="text-sm text-muted-foreground">Scegli una persona o un riquadro per vedere le dipendenze documentate.</p>;
  } else if (selType === 'person') {
    const owed = lay.edges.filter((edge) => edge.from === sel && nodes.has(edge.to));
    panel = <>
      <h3 className="text-base font-semibold">{sel === 'you' ? 'Cosa devi fare tu' : `Cosa aspetti da ${nameOf(sel)}`}</h3>
      {people.get(sel) && <p className="mt-0.5 text-[13px] text-muted-foreground"><Glossed text={people.get(sel)!.role} /></p>}
      <div key={sel} className="mt-3 space-y-2">{owed.map((edge, index) => {
        const node = nodes.get(edge.to)!;
        return <Fold key={`${edge.from}-${edge.to}`} open={index === 0} className="rounded-lg border bg-background/70 px-3 py-2"
          title={<span className="text-sm font-medium">«{node.label}»{waited(node) && <span className={cn('font-normal whitespace-nowrap text-muted-foreground', node.status === 'blocked' && 'text-destructive')}> · {waited(node)}</span>}</span>}>
          <ol className="space-y-2">{chain(edge, 1)}</ol></Fold>;
      })}</div>
      {!owed.length && <p className="mt-2 text-sm text-muted-foreground">Nessuna dipendenza documentata per questa persona.</p>}
    </>;
  } else {
    const node = nodes.get(sel)!;
    const incoming = lay.edges.filter((edge) => edge.to === sel), onward = lay.edges.filter((edge) => edge.from === sel);
    panel = <>
      <h3 className="text-base font-semibold">{node.label}</h3>
      <p className="mt-0.5 text-[13px] text-muted-foreground">{statusText[node.status]}{node.since && node.status !== 'done' ? ` · dal ${node.since.slice(8, 10)}/${node.since.slice(5, 7)} · ${waited(node)}` : ''}{node.owner ? ` · ${nameOf(node.owner)}` : ''}</p>
      <p className="mt-2 text-sm leading-snug"><Glossed text={node.plain} /><GuideSources ids={node.src} sources={explainer.sources} /><FlagButton text={node.plain} /></p>
      {!incoming.length && !onward.length && <p className="mt-2 text-sm text-muted-foreground">Nessuna dipendenza documentata per questo elemento.</p>}
      {[['Da cosa dipende', incoming], ['Cosa sblocca', onward]].map(([title, list], group) => !!(list as ExplainerEdge[]).length && <div key={group} className="mt-3">
        <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title as string}</h4>
        <div className="space-y-1.5">{(list as ExplainerEdge[]).map((edge, index) => <Fold key={`${edge.from}-${edge.to}`} open={index === 0 && (group === 0 || !incoming.length)}
          className="rounded-lg border bg-background/70 px-3 py-2" title={<span className="text-sm leading-snug font-medium">{group === 0
            ? edge.kind === 'owes' ? edge.from === 'you' ? verbs[node.kind][1] : `${nameOf(edge.from)} ${verbs[node.kind][0]}` : `Serve prima «${labelOf(edge.from)}»`
            : edge.to === 'goal' ? `Il traguardo: ${explainer.goal.label}` : `«${labelOf(edge.to)}»`}</span>}>
          <p className="text-[13px] leading-snug text-muted-foreground"><Glossed text={edge.why} /><GuideSources ids={edge.src} sources={explainer.sources} /><FlagButton text={edge.why} /></p>
        </Fold>)}</div>
      </div>)}
    </>;
  }

  return <div ref={frameRef} className={cn('relative min-w-0', props.className)}>
    <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute h-0 w-0 overflow-hidden">
      {explainer.graph.nodes.map((node) => <div key={node.id} data-measure-node={node.id} style={{ width: NODE_W - 20 }} className="break-words text-[12px] leading-tight font-semibold">{node.label}</div>)}
      {[{ id: 'you', name: 'Tu' }, ...explainer.people].map((person) => <div key={person.id}>
        <span data-measure-name="" className="inline-block whitespace-nowrap text-[13px] leading-tight font-medium">{person.name}</span>
        <div data-measure-person={person.id} style={{ width: personWidth - 56 }} className="break-words text-[13px] leading-tight font-medium">{person.name}</div>
      </div>)}
    </div>
    {!sel && <aside aria-live="polite" aria-label="Spiegazione della catena" className="mb-2">{panel}</aside>}
    <div ref={scrollRef} className="min-w-0 max-w-full overflow-x-auto rounded-xl border bg-card" data-graph-scroll="" role="region" aria-label="Mappa delle dipendenze" tabIndex={0}>
      <div data-graph="" data-focus={sel ?? undefined} className="relative" style={{ width: lay.width, height: lay.height }}
        onClick={(event) => { if (event.target === event.currentTarget && sel) choose(null); }}>
        <svg width={lay.width} height={lay.height} aria-hidden="true" className="pointer-events-none absolute inset-0">
          <defs>
            {[['plain', 'var(--input)'], ['live', 'var(--primary)']].map(([name, color]) =>
              <marker key={name} id={`graph-arrow-${name}`} viewBox="0 0 8 8" refX="8" refY="4" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0L8,4L0,8z" fill={color} /></marker>)}
          </defs>
          {lay.edges.map((edge) => {
            const from = lay.items.get(edge.from), to = lay.items.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + from.w, y1 = lay.ports.get(edge)!.from, x2 = to.x, y2 = lay.ports.get(edge)!.to;
            let x = x1, y = y1, d = `M${x},${y}`;
            for (const point of lay.waypoints.get(edge)!) {
              const bend = (point.left - x) / 2;
              d += ` C${x + bend},${y} ${point.left - bend},${point.y} ${point.left},${point.y} H${point.right}`;
              x = point.right; y = point.y;
            }
            const bend = (x2 - 12 - x) / 2;
            d += ` C${x + bend},${y} ${x2 - 12 - bend},${y2} ${x2 - 12},${y2}`;
            const live = !!trace && trace.used.has(edge);
            return <g key={`${edge.from}-${edge.to}`} opacity={edgeDim(edge) ? 0.08 : 1} className="transition-opacity">
              <path data-edge={`${edge.from}>${edge.to}`} data-kind={edge.kind} data-dim={edgeDim(edge) ? 'true' : undefined} data-live={live ? 'true' : undefined}
              d={d} fill="none" strokeWidth={live ? 2.5 : 1.6}
              stroke={live ? 'var(--primary)' : 'var(--input)'} strokeDasharray={live ? '8 6' : edge.kind === 'owes' ? '5 4' : undefined}
              className={cn('transition-opacity', live && 'animate-[dash-flow_0.9s_linear_infinite]')} />
              <path d={`M${x2 - 12},${y2} H${x2}`} fill="none" strokeWidth={live ? 2.5 : 1.6} stroke={live ? 'var(--primary)' : 'var(--input)'} markerEnd={`url(#graph-arrow-${live ? 'live' : 'plain'})`} />
            </g>;
          })}
        </svg>
        {[...lay.items.values()].map((item) => {
          const style = { left: item.x, top: item.y, width: item.w, height: item.h };
          const faded = dim(item.id) ? 'true' : undefined;
          const common = 'absolute text-left transition-opacity data-[dim=true]:opacity-10 aria-pressed:ring-2 aria-pressed:ring-primary';
          if (item.type === 'goal') return <div key={item.id} data-goal="" data-dim={faded} style={style}
            className="absolute flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-primary-foreground shadow-sm transition-opacity data-[dim=true]:opacity-10">
            <Flag aria-hidden="true" className="size-4 shrink-0" /><span className="line-clamp-3 text-[13px] leading-tight font-semibold">{explainer.goal.label}</span></div>;
          if (item.type === 'person') {
            const name = item.id === 'you' ? 'Tu' : people.get(item.id)?.name ?? item.id;
            return <button key={item.id} type="button" data-person={item.id} data-dim={faded} aria-pressed={sel === item.id} style={style}
              aria-label={item.id === 'you' ? 'Tu: cosa devi fare' : `${name}: cosa aspetti`} onClick={() => choose(sel === item.id ? null : item.id)}
              className={cn(common, 'flex items-center gap-2 rounded-full border-2 px-2.5 text-[13px] font-medium hover:bg-accent', item.id === 'you' ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-card')}>
              <span aria-hidden="true" className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold', item.id === 'you' ? 'bg-primary-foreground/20' : 'bg-muted')}>{item.id === 'you' ? 'TU' : initials(name)}</span>
              <span className="min-w-0 break-words leading-tight">{name}</span></button>;
          }
          const node = nodes.get(item.id)!;
          return <button key={item.id} type="button" data-node={item.id} data-status={node.status} data-dim={faded} aria-pressed={sel === item.id} style={style}
            aria-label={`${node.label}, ${statusText[node.status]}`} onClick={() => choose(sel === item.id ? null : item.id)}
            className={cn(common, 'flex flex-col justify-between gap-2 rounded-lg border-2 px-2 py-1.5 hover:shadow-sm', statusTone[node.status])}>
            <span className="break-words text-[12px] leading-tight font-semibold">{node.label}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span aria-hidden="true" className="flex size-4 items-center justify-center rounded-full bg-muted text-[8px] font-semibold text-foreground">{node.owner === 'you' ? 'TU' : initials(nameOf(node.owner))}</span>
              {waited(node) && <span className={cn('font-medium', node.status === 'blocked' && 'text-destructive')} title={`In attesa da ${workDays(node.since, today)} giorni lavorativi`}>{waited(node)}</span>}
              <span className="ml-auto">{statusText[node.status]}</span>
            </span>
          </button>;
        })}
      </div>
    </div>
    {sel && (panelOpen ? <aside ref={panelRef} aria-live="polite" aria-label="Spiegazione della catena" style={panelPosition ? { left: panelPosition.left, top: panelPosition.top } : undefined}
      className={cn('z-20 mt-3 min-w-0 rounded-xl border bg-card shadow-sm sm:w-[min(24rem,calc(100%-24px))]', panelPosition && 'absolute mt-0 max-h-[75vh] overflow-y-auto shadow-xl')}>
      <div onPointerDown={startDrag} title={panelPosition ? 'Trascina per spostare' : undefined}
        className={cn('sticky top-0 z-10 flex items-center gap-2 rounded-t-xl border-b bg-muted/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur', panelPosition && 'cursor-move touch-none select-none')}>
        {panelPosition && <GripHorizontal aria-hidden="true" className="size-4" />}<span className="font-medium">Spiegazione</span>
        <button type="button" onClick={() => choose(null)} className="ml-auto rounded px-1.5 py-0.5 font-medium text-primary hover:bg-accent">Togli la selezione (Esc)</button>
        <button type="button" aria-label="Nascondi spiegazione" onClick={() => setPanelOpen(false)} className="rounded p-1 hover:bg-accent"><X aria-hidden="true" className="size-4" /></button>
      </div>
      <div className="p-4">{panel}</div>
    </aside> : <button ref={pillRef} type="button" onClick={() => setPanelOpen(true)} style={panelPosition ? { left: panelPosition.left, top: panelPosition.top } : undefined}
      className={cn('z-20 mt-3 rounded-full border bg-card px-3 py-1.5 text-xs font-medium text-primary shadow-sm hover:bg-accent', panelPosition && 'absolute mt-0 shadow-lg')}>Mostra spiegazione</button>)}
  </div>;
}
