'use client';

import { Flag } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Explainer, ExplainerEdge, ExplainerNode } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Glossed } from './glossed.tsx';
import { GuideSources } from './sources.tsx';

const COL = 216, NODE_W = 172, NODE_H = 60, PERSON_W = 136, PERSON_H = 40, GOAL_W = 176, GOAL_H = 88, GAP = 14, PAD = 14;

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

function layout(g: Explainer) {
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
  const kind = (id: string): Item['type'] => id === 'goal' ? 'goal' : ids.has(id) ? 'node' : 'person';
  const size = (id: string) => kind(id) === 'goal' ? [GOAL_W, GOAL_H] as const : kind(id) === 'node' ? [NODE_W, NODE_H] as const : [PERSON_W, PERSON_H] as const;
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
    const ys = edges.filter((edge) => forward ? edge.to === id : edge.from === id).map((edge) => centers.get(forward ? edge.from : edge.to)!).filter((y) => y !== undefined);
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
    items.set(id, { id, type: kind(id), col: c, x: PAD + c * COL, y: PAD + centers.get(id)! - h / 2, w, h });
  }));
  return { items, edges, width: PAD * 2 + goalCol * COL + GOAL_W, height: total + PAD * 2 };
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
      {props.src && <GuideSources ids={props.src} sources={props.sources} />}
    </span>
  </li>;
}

export function DependencyGraph(props: { explainer: Explainer; today: string; focus?: string | null; onFocusChange?: (id: string | null) => void; className?: string }) {
  const { explainer, today, onFocusChange } = props;
  const [selected, setSelected] = useState<string | null>(props.focus ?? null);
  useEffect(() => { setSelected(props.focus ?? null); }, [props.focus]);
  const lay = useMemo(() => layout(explainer), [explainer]);
  const people = useMemo(() => new Map(explainer.people.map((person) => [person.id, person])), [explainer]);
  const nodes = useMemo(() => new Map(explainer.graph.nodes.map((node) => [node.id, node])), [explainer]);
  const sel = selected && (lay.items.has(selected) || selected === 'you' || people.has(selected)) && selected !== 'goal' ? selected : null;
  const selType = sel ? lay.items.get(sel)?.type ?? 'person' : null;
  const trace = useMemo(() => sel ? reach(lay.edges, sel, selType === 'node', true) : null, [lay, sel, selType]);
  const choose = (id: string | null) => { setSelected(id); onFocusChange?.(id); };
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

  const chain = (edge: ExplainerEdge, first: number) => {
    const steps: React.ReactNode[] = [];
    const node = nodes.get(edge.to);
    if (node) {
      const verb = verbs[node.kind][edge.from === 'you' ? 1 : 0];
      const days = node.since && node.status !== 'done' ? ` (da ${workDays(node.since, today)} giorni lavorativi)` : '';
      steps.push(<Step key="own" n={first} why={edge.why} src={edge.src} sources={explainer.sources}>
        {edge.from === 'you' ? `${verb}: ` : `${nameOf(edge.from)} ${verb}: `}«{node.label}»{days}</Step>);
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
    panel = <p className="text-sm text-muted-foreground">Scegli una persona o un riquadro: il resto sfuma e qui sotto compaiono le dipendenze documentate.</p>;
  } else if (selType === 'person') {
    const owed = lay.edges.filter((edge) => edge.from === sel && nodes.has(edge.to));
    panel = <>
      <h3 className="text-base font-semibold">{sel === 'you' ? 'Cosa devi fare tu' : `Cosa aspetti da ${nameOf(sel)}`}</h3>
      {people.get(sel) && <p className="mt-0.5 text-[13px] text-muted-foreground"><Glossed text={people.get(sel)!.role} /></p>}
      <div className="mt-3 space-y-4">{owed.map((edge) => <ol key={`${edge.from}-${edge.to}`} className="space-y-2.5 border-l-2 border-primary/30 pl-3">{chain(edge, 1)}</ol>)}</div>
      {!owed.length && <p className="mt-2 text-sm text-muted-foreground">Nessuna dipendenza documentata per questa persona.</p>}
    </>;
  } else {
    const node = nodes.get(sel)!;
    const incoming = lay.edges.filter((edge) => edge.to === sel), onward = pathToGoal(lay.edges, sel);
    panel = <>
      <h3 className="text-base font-semibold">{node.label}</h3>
      <p className="mt-0.5 text-[13px] text-muted-foreground">{statusText[node.status]}{node.since && node.status !== 'done' ? `, in attesa da ${workDays(node.since, today)} giorni lavorativi` : ''}{node.owner ? ` · ${nameOf(node.owner)}` : ''}</p>
      <p className="mt-2 text-sm leading-snug"><Glossed text={node.plain} /><GuideSources ids={node.src} sources={explainer.sources} /></p>
      {!incoming.length && !onward.length && <p className="mt-2 text-sm text-muted-foreground">Nessuna dipendenza documentata per questo elemento.</p>}
      {!!incoming.length && <><h4 className="mt-4 mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Da cosa dipende</h4>
        <ul className="space-y-2">{incoming.map((edge) => <li key={`${edge.from}-${edge.to}`} className="text-sm leading-snug">
          <span className="font-medium">{edge.kind === 'owes' ? `${nameOf(edge.from)} deve consegnarlo` : `Serve prima «${labelOf(edge.from)}»`}</span>
          <span className="block text-[13px] text-muted-foreground"><Glossed text={edge.why} /><GuideSources ids={edge.src} sources={explainer.sources} /></span></li>)}</ul></>}
      {!!onward.length && <><h4 className="mt-4 mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Cosa sblocca</h4>
        <ol className="space-y-2.5 border-l-2 border-primary/30 pl-3">{onward.map((next, index) =>
          <Step key={`${next.from}-${next.to}`} n={index + 1} why={next.why} src={next.src} sources={explainer.sources}>
             {next.to === 'goal' ? <>Il traguardo: {explainer.goal.label}</> : <>«{labelOf(next.to)}»</>}</Step>)}</ol></>}
      {onward.length > 0 && onward.at(-1)?.to !== 'goal' && <p className="mt-2 text-sm text-muted-foreground">Nessun collegamento successivo al traguardo documentato.</p>}
    </>;
  }

  return <div className={cn('grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_21rem]', props.className)}>
    <div className="min-w-0 overflow-x-auto rounded-xl border bg-card" data-graph-scroll="" role="region" aria-label="Mappa delle dipendenze" tabIndex={0}>
      <div data-graph="" data-focus={sel ?? undefined} className="relative" style={{ width: lay.width, height: lay.height }}
        onClick={(event) => { if (event.target === event.currentTarget && sel) choose(null); }}>
        <svg width={lay.width} height={lay.height} aria-hidden="true" className="pointer-events-none absolute inset-0">
          <defs>
            {[['plain', 'var(--input)'], ['live', 'var(--primary)']].map(([name, color]) =>
              <marker key={name} id={`graph-arrow-${name}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill={color} /></marker>)}
          </defs>
          {lay.edges.map((edge) => {
            const from = lay.items.get(edge.from), to = lay.items.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + from.w, y1 = from.y + from.h / 2, x2 = to.x - 3, y2 = to.y + to.h / 2, bend = Math.max(36, (x2 - x1) / 2);
            const live = !!trace && trace.used.has(edge);
            return <path key={`${edge.from}-${edge.to}`} data-edge={`${edge.from}>${edge.to}`} data-kind={edge.kind} data-dim={edgeDim(edge) ? 'true' : undefined} data-live={live ? 'true' : undefined}
              d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`} fill="none" strokeWidth={live ? 2.5 : 1.6}
              stroke={live ? 'var(--primary)' : 'var(--input)'} strokeDasharray={live ? '8 6' : edge.kind === 'owes' ? '5 4' : undefined}
              markerEnd={`url(#graph-arrow-${live ? 'live' : 'plain'})`} opacity={edgeDim(edge) ? 0.08 : 1}
              className={cn('transition-opacity', live && 'animate-[dash-flow_0.9s_linear_infinite]')} />;
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
              <span className="truncate">{name}</span></button>;
          }
          const node = nodes.get(item.id)!;
          return <button key={item.id} type="button" data-node={item.id} data-status={node.status} data-dim={faded} aria-pressed={sel === item.id} style={style}
            aria-label={`${node.label}, ${statusText[node.status]}`} onClick={() => choose(sel === item.id ? null : item.id)}
            className={cn(common, 'flex flex-col justify-between rounded-lg border-2 px-2 py-1.5 hover:shadow-sm', statusTone[node.status])}>
            <span className="line-clamp-2 text-[12px] leading-tight font-semibold">{node.label}</span>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span aria-hidden="true" className="flex size-4 items-center justify-center rounded-full bg-muted text-[8px] font-semibold text-foreground">{node.owner === 'you' ? 'TU' : initials(nameOf(node.owner))}</span>
              {waited(node) && <span className={cn('font-medium', node.status === 'blocked' && 'text-destructive')} title={`In attesa da ${workDays(node.since, today)} giorni lavorativi`}>{waited(node)}</span>}
              <span className="ml-auto">{statusText[node.status]}</span>
            </span>
          </button>;
        })}
      </div>
    </div>
    <aside aria-live="polite" aria-label="Spiegazione della catena" className="min-w-0 rounded-xl border bg-card p-4 lg:sticky lg:top-24">
      {panel}
      {sel && <button type="button" onClick={() => choose(null)} className="mt-4 text-xs font-medium text-primary hover:underline">Mostra tutto (Esc)</button>}
    </aside>
  </div>;
}
