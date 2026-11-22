'use client';

import { ArrowRight, BookOpen, Bot, Check, ChevronDown, ChevronUp, Copy, LayoutGrid, LogOut, Network, RefreshCw, TriangleAlert, User, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanSourceText, italianDates } from '../../lib/web-types.ts';
import type { Explainer, GuideState, InitiativeLine, InitiativeNext, InitiativesState, InitiativeStateName, InitiativeTicket, InitiativeView, InitiativeWait } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Inline } from '../tickets/markdown.tsx';
import { Expand, Field } from '../tickets/ticket-card.tsx';
import { DependencyGraph, initials } from './dependency-graph.tsx';
import { formatDate, formatInitiativeTime as formatTime, Sources } from './sources.tsx';

const POLL_MS = 15_000;
// Waits on others older than this many working days turn red
export const OVERDUE_DAYS = 5;

function themDays(view: InitiativeView): number {
  return Math.max(0, ...(view.summary?.waits ?? []).filter((wait) => wait.owes === 'them').map((wait) => wait.days));
}

const stateLabels: Record<InitiativeStateName, string> = { moving: 'Moving', waiting_them: 'Waiting on them', needs_you: 'Needs you', stuck: 'Stuck', quiet: 'Quiet' };

export function StatePill({ view }: { view: InitiativeView }) {
  const summary = view.summary;
  if (!summary) return <span className="w-fit rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Not summed up yet</span>;
  const days = themDays(view);
  const tone = summary.state === 'stuck' || summary.state === 'waiting_them' && days > OVERDUE_DAYS ? 'bg-destructive-soft text-destructive'
    : summary.state === 'needs_you' ? 'bg-accent text-accent-foreground' : summary.state === 'waiting_them' ? 'bg-warning-soft text-warning'
    : summary.state === 'moving' ? 'bg-info-soft text-info' : 'bg-muted text-muted-foreground';
  return <span data-state={summary.state} className={cn('w-fit rounded-full px-2 py-0.5 text-[11px] font-semibold', tone)}>
    {stateLabels[summary.state]}{summary.state === 'waiting_them' && days > 0 ? ` · ${days}d` : ''}
  </span>;
}

// Text with `code` shown as a quiet monospace span instead of a boxed chip
function Text({ text }: { text: string }) {
  return <>{italianDates(text).split(/(`[^`\n]+`)/).map((part, index) => index % 2
    ? <span key={index} className="font-mono text-[0.88em] text-foreground/75">{part.slice(1, -1)}</span> : <Inline key={index} text={part} />)}</>;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Only use a name when it identifies one person in the guide.
export function guidePerson(explainer: Explainer, who: string): string | null {
  if (who === 'you') return 'you';
  const first = (name: string) => name.split(/\s+/)[0] ?? '';
  const exact = explainer.people.filter((item) => same(item.name, who) || !!item.short && same(item.short, who));
  if (exact.length) return exact.length === 1 ? exact[0]!.id : null;
  if (who.trim().split(/\s+/).length !== 1) return null;
  const matches = explainer.people.filter((item) => same(first(item.name), first(who)));
  return matches.length === 1 ? matches[0]!.id : null;
}

// Source IDs are local to each generation, so compare the cited text, not the IDs.
function guideNode(explainer: Explainer, line: InitiativeLine): string | null {
  const normalize = (text: string) => text.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  const wait = 'who' in line && 'owes' in line ? line as InitiativeWait : null;
  const person = wait ? wait.owes === 'you' ? 'you' : guidePerson(explainer, wait.who) : null;
  if (wait && !person) return null;
  const matches = explainer.graph.nodes.filter((node) => normalize(node.label) === normalize(line.text)
    && node.src.some((id) => explainer.sources[id] && line.sources.some((source) => normalize(source.text) === normalize(explainer.sources[id]!.text)))
    && (!wait || explainer.graph.edges.some((edge) => edge.kind === 'owes' && edge.from === person && edge.to === node.id && edge.src.some((id) => !!explainer.sources[id]))));
  return matches.length === 1 ? matches[0]!.id : null;
}

type Person = { who: string; waits: InitiativeWait[]; tone: 'overdue' | 'them' | 'you' };
const strokes = { overdue: 'var(--destructive)', them: 'var(--info)', you: 'var(--warning)' };

// Who owes what: each person around Antonio, arrows the way the missing piece has to travel. focus fades everybody else.
export function PeopleMap({ waits, focus, onFocus }: { waits: InitiativeWait[]; focus?: string | null | undefined; onFocus?: (who: string) => void }) {
  const people: Person[] = [];
  for (const wait of waits) {
    let person = people.find((item) => same(item.who, wait.who));
    if (!person) { if (people.length >= 8) continue; person = { who: wait.who, waits: [], tone: 'them' }; people.push(person); }
    person.waits.push(wait);
  }
  for (const person of people) {
    person.tone = person.waits.some((wait) => wait.owes === 'them' && wait.days > OVERDUE_DAYS) ? 'overdue'
      : person.waits.some((wait) => wait.owes === 'you') ? 'you' : 'them';
  }
  if (!people.length) return <p className="rounded-lg bg-background px-3 py-10 text-center text-xs text-muted-foreground">Nobody owes anything open.</p>;
  const width = 560, height = 280, cx = width / 2, cy = height / 2, center = 24, node = 18;
  const placed = people.map((person, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / people.length + (people.length % 2 ? 0 : Math.PI / people.length);
    return { ...person, x: cx + 215 * Math.cos(angle), y: cy + 95 * Math.sin(angle) };
  });
  const faded = (person: Person) => !!focus && (focus === 'you' ? person.tone !== 'you' : !same(person.who, focus));
  const press = (who: string) => ({
    role: 'button' as const, tabIndex: 0, onClick: () => onFocus?.(who),
    onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onFocus?.(who); } },
  });
  return <div className="overflow-x-auto rounded-lg" tabIndex={0} role="region" aria-label="Mappa delle richieste">
  <svg role="group" aria-label={`Open requests: ${placed.map((person) => `${person.who} ${person.waits.length}`).join(', ')}`} viewBox={`0 0 ${width} ${height}`}
    className="h-[280px] min-w-[560px] w-full rounded-lg bg-background">
    <defs>{Object.entries(strokes).map(([tone, color]) => <marker key={tone} id={`arrow-${tone}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0L10,5L0,10z" fill={color} /></marker>)}</defs>
    {placed.map((person) => {
      const dx = person.x - cx, dy = person.y - cy, length = Math.hypot(dx, dy) || 1;
      const ux = dx / length, uy = dy / length;
      const outward = person.tone === 'you';
      const [x1, y1, x2, y2] = outward ? [cx + ux * center, cy + uy * center, person.x - ux * (node + 3), person.y - uy * (node + 3)]
        : [person.x - ux * node, person.y - uy * node, cx + ux * (center + 3), cy + uy * (center + 3)];
      const days = Math.max(...person.waits.map((wait) => wait.days));
      const label = `${person.waits.length} open · ${days}d`;
      const below = person.y >= cy;
      const dim = faded(person);
      const on = !!focus && !dim;
      return <g key={person.who} data-person={person.who} data-tone={person.tone} data-dim={dim ? 'true' : undefined} aria-pressed={on} aria-label={`${person.who}: ${label}`}
        className={cn('cursor-pointer outline-none transition-opacity focus-visible:[&_circle:nth-of-type(2)]:stroke-[4]', dim && 'opacity-15')} {...press(person.who)}>
        <title>{person.waits.map((wait) => `${wait.owes === 'you' ? 'You owe' : 'Owes you'}: ${wait.text} (${wait.days} working days)\n${wait.sources.map((source) => cleanSourceText(source.text)).join('\n')}`).join('\n\n')}</title>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={strokes[person.tone]} strokeWidth={on ? 3 : 2} strokeDasharray="6 4" markerEnd={`url(#arrow-${person.tone})`}
          className={cn(!dim && 'animate-[dash-flow_1.2s_linear_infinite]')} />
        {person.tone === 'overdue' && !dim && <circle cx={person.x} cy={person.y} r={node} fill="var(--destructive)" className="origin-center animate-[node-pulse_1.8s_ease-out_infinite] [transform-box:fill-box]" />}
        <circle cx={person.x} cy={person.y} r={node + 10} fill="transparent" />
        <circle cx={person.x} cy={person.y} r={node} fill="var(--card)" stroke={strokes[person.tone]} strokeWidth={on ? 3.5 : 2} />
        <text x={person.x} y={person.y + 3.5} textAnchor="middle" fontSize="10" fill="var(--foreground)">{initials(person.who)}</text>
        <text x={person.x} y={below ? person.y + node + 13 : person.y - node - 18} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--foreground)">{person.who}</text>
        <text x={person.x} y={below ? person.y + node + 25 : person.y - node - 6} textAnchor="middle" fontSize="10" fontWeight="600" fill={strokes[person.tone]}>{label}</text>
      </g>;
    })}
    <g data-you="" aria-label="You" aria-pressed={focus === 'you'} className="cursor-pointer outline-none focus-visible:[&_circle]:stroke-foreground" {...press('you')}>
      <circle cx={cx} cy={cy} r={center} fill="var(--primary)" stroke={focus === 'you' ? 'var(--foreground)' : 'none'} strokeWidth={3} />
      <text x={cx} y={cy + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--primary-foreground)">You</text>
    </g>
  </svg></div>;
}

// Without a guide: what is open with the focused person, with the days waited and the lines it rests on
function FocusWaits({ waits, focus, onReset }: { waits: InitiativeWait[]; focus: string; onReset: () => void }) {
  const mine = focus === 'you';
  const open = waits.filter((wait) => mine ? wait.owes === 'you' : same(wait.who, focus));
  return <div data-focus-waits="" className="mt-2 rounded-lg border bg-background p-3 text-sm">
    <div className="flex items-center gap-2">
      <h4 className="font-semibold">{mine ? 'What you owe' : `What you wait for from ${focus}`}</h4>
      <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={onReset}>Torna alla mappa</Button>
    </div>
    {!open.length && <p className="mt-1 text-xs text-muted-foreground">Nothing open.</p>}
    <div className="mt-1.5 space-y-2">{open.map((wait, index) => <p key={index} className="leading-snug">
      <Text text={wait.text} /><Sources sources={wait.sources} />
      <span className={cn('mt-0.5 block text-xs', wait.owes === 'them' && wait.days > OVERDUE_DAYS ? 'font-medium text-destructive' : 'text-muted-foreground')}>
        {wait.days === 0 ? 'since today' : `${wait.days} working day${wait.days === 1 ? '' : 's'}`}
      </span>
    </p>)}</div>
    <p className="mt-2 text-xs text-muted-foreground">Nessuna dipendenza documentata per questa selezione.</p>
  </div>;
}

function FocusLine({ line, onReset }: { line: InitiativeLine; onReset: () => void }) {
  return <div data-focus-line="" className="rounded-lg border bg-background p-3 text-sm">
    <div className="flex items-start gap-2"><p><Text text={line.text} /><Sources sources={line.sources} /></p>
      <Button type="button" variant="ghost" size="xs" className="ml-auto shrink-0" onClick={onReset}>Torna alla mappa</Button></div>
    <p className="mt-2 text-muted-foreground">Nessuna dipendenza documentata per questa scheda.</p>
  </div>;
}

function Draft({ next }: { next: InitiativeNext }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!next.draft) return null;
  return <div className="mt-2">
    <div className="flex gap-1">
      <Button type="button" variant="outline" size="xs" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}Draft</Button>
      <Button type="button" variant="outline" size="xs" onClick={() => { void navigator.clipboard?.writeText(next.draft!).then(() => setCopied(true)); }}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? 'Copied' : 'Copy'}</Button>
    </div>
    {open && <pre className="mt-1.5 rounded-md border bg-card p-2.5 font-sans text-xs whitespace-pre-wrap">{next.draft}</pre>}
  </div>;
}

function Column(props: { title: string; icon: React.ReactNode; count: number; tone: string; children: React.ReactNode }) {
  return <section aria-label={`${props.title} (${props.count})`} className={cn('flex min-w-0 flex-col gap-2 rounded-xl border-t-[3px] bg-muted/70 p-2.5 ring-1 ring-border/60', props.tone)}>
    <h3 className="flex items-center gap-1.5 px-0.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{props.icon}{props.title}
      <span className="ml-auto rounded-full bg-background px-2 tabular-nums">{props.count}</span></h3>
    {props.count === 0 && <p className="px-1 py-3 text-center text-xs text-muted-foreground">Nothing.</p>}
    {props.children}
  </section>;
}

const dayMonth = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

// The fields of a note ticket in the board's boxes: what is awaited, then the row of its table in the note
function TicketFields({ ticket }: { ticket: InitiativeTicket }) {
  const fields = [['Waiting for', ticket.ask], ...ticket.details.map((detail) => [detail.label, detail.value])].filter((field): field is [string, string] => !!field[1]);
  return fields.length ? <dl className="grid gap-1.5">{fields.map(([label, value]) => <Field key={label} label={label} expanded><Text text={value} /></Field>)}</dl>
    : <p className="text-sm text-muted-foreground">No details in the note.</p>;
}

function TicketMeta({ ticket }: { ticket: InitiativeTicket }) {
  return <>
    <span className="font-mono">{ticket.id}</span>
    {ticket.who && <span>{ticket.who}</span>}
    {ticket.since && <span>since {formatDate(ticket.since)}</span>}
    {ticket.after && <span>after {ticket.after}</span>}
    {ticket.done_at && <span>done {formatDate(ticket.done_at)}</span>}
  </>;
}

// A card from the note's tickets opens the board's Expand popup with all its fields; a summary card shows its sources and its dependencies in the map
function Item({ line, bar, onFocus, label, children }: { line: InitiativeLine; bar: string; onFocus?: () => void; label?: string; children?: React.ReactNode }) {
  const box = cn('group relative rounded-lg border border-l-[3px] bg-card p-2.5 pr-8 text-[13px] leading-snug shadow-xs', bar);
  const tickets = line.tickets ?? [];
  if (tickets.length) {
    const single = tickets.length === 1 ? tickets[0]! : null;
    return <Expand label={single ? `Open ticket ${single.id}` : `Open tickets ${tickets.map((ticket) => ticket.id).join(', ')}`}
      title={single ? `${single.id} ${single.title}` : line.text.replaceAll('**', '')}
      meta={single ? <TicketMeta ticket={single} /> : <span>{tickets.length} tickets</span>}
      trigger={<button type="button" className={cn(box, 'block w-full cursor-pointer text-left hover:border-foreground/25')}><Text text={line.text} />{children}</button>}>
      {single ? <TicketFields ticket={single} /> : <div className="space-y-4">{tickets.map((ticket) => <section key={ticket.id} className="space-y-1.5">
        <h3 className="text-sm font-semibold">{`${ticket.id} ${ticket.title}`}</h3>
        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground"><TicketMeta ticket={ticket} /></p>
        <TicketFields ticket={ticket} />
      </section>)}</div>}
    </Expand>;
  }
  return <div onClick={(event) => { if (onFocus && !(event.target as Element).closest('button, a')) onFocus(); }}
    className={cn(box, onFocus && 'cursor-pointer hover:border-foreground/25')}>
    <Text text={line.text} /><Sources sources={line.sources} />
    {children}
    {onFocus && <button type="button" aria-label={label ?? 'Show in the map'} title={label ?? 'Show in the map'} onClick={onFocus}
      className="absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"><Network aria-hidden="true" className="size-3.5" /></button>}
  </div>;
}
function GuideLink({ id, ready, size }: { id: string; ready: boolean; size: 'card' | 'head' }) {
  const href = `/overview/${encodeURIComponent(id)}`;
  if (size === 'card') return <a href={href} className={cn('inline-flex items-center gap-1.5 text-xs font-medium hover:underline', ready ? 'text-primary' : 'text-muted-foreground')}>
    <BookOpen aria-hidden="true" className="size-3.5" />{ready ? 'Apri la guida' : 'Guida in preparazione'}{ready && <ArrowRight aria-hidden="true" className="size-3.5" />}</a>;
  return <a href={href} className={cn('inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-semibold', ready ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'border bg-background text-muted-foreground hover:bg-accent')}>
    <BookOpen aria-hidden="true" className="size-4" />{ready ? 'Apri la guida' : 'Guida in preparazione'}{ready && <ArrowRight aria-hidden="true" className="size-4" />}</a>;
}

function Detail({ view, guide }: { view: InitiativeView; guide: GuideState | null }) {
  const summary = view.summary;
  const explainer = guide?.explainer ?? null;
  const [focus, setFocus] = useState<{ who?: string; line?: InitiativeLine; tick: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const pick = (who: string) => {
    setFocus((current) => ({ who, tick: (current?.tick ?? 0) + 1 }));
    area.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  };
  const pickLine = (line: InitiativeLine) => {
    setFocus((current) => ({ line, tick: (current?.tick ?? 0) + 1 }));
    area.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  };
  const graphFocus = focus && explainer ? focus.line ? guideNode(explainer, focus.line) : focus.who ? guidePerson(explainer, focus.who) : null : null;
  const them = summary?.waits.filter((wait) => wait.owes === 'them').sort((a, b) => b.days - a.days) ?? [];
  const count = (owner: 'ai' | 'you') => summary?.next.filter((next) => next.owner === owner) ?? [];
  return <section aria-label={`${view.client} ${view.title}`} className="space-y-5 rounded-xl border bg-card p-4 shadow-xs sm:p-6">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="text-lg font-semibold"><span className="mr-2 text-xs font-normal tracking-wide text-muted-foreground uppercase">{view.client}</span>{view.title}</h2>
      <StatePill view={view} />
      <span className="truncate font-mono text-[11px] text-muted-foreground sm:ml-auto" title="Vault note">{view.note}</span>
      <GuideLink id={view.id} ready={!!explainer} size="head" />
    </div>
    {view.error && <Alert variant="destructive" className="border-destructive/30 bg-destructive-soft">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Last refresh failed{view.error_at ? ` at ${formatTime(view.error_at)}` : ''}</AlertTitle>
      <AlertDescription>{view.error}{summary && view.at ? `. Showing the summary of ${formatTime(view.at)}.` : ''}</AlertDescription>
    </Alert>}
    {!summary ? <p className="py-6 text-center text-sm text-muted-foreground">No summary yet. Refresh to build it from the note.</p> : <>
      <p className="max-w-4xl text-xl leading-snug font-semibold tracking-tight sm:text-2xl"><Text text={summary.headline} /></p>
      <div ref={area} className="scroll-mt-24">
        {focus && explainer && graphFocus ? <DependencyGraph key={focus.tick} explainer={explainer} today={guide!.today} focus={graphFocus} onFocusChange={(id) => { if (id === null) setFocus(null); }} />
          : focus?.line ? <FocusLine line={focus.line} onReset={() => setFocus(null)} /> : <div className="grid items-start gap-5 lg:grid-cols-[1.1fr_1fr]">
            <div>
              <PeopleMap waits={summary.waits} focus={focus?.who} onFocus={(who) => focus?.who && same(focus.who, who) ? setFocus(null) : pick(who)} />
              {focus?.who && <FocusWaits waits={summary.waits} focus={focus.who} onReset={() => setFocus(null)} />}
            </div>
            <NowList summary={summary} />
          </div>}
      </div>
      {focus && explainer && graphFocus && <NowList summary={summary} />}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Column title="AI" tone="border-t-primary" icon={<Bot aria-hidden="true" className="size-4 text-primary" />} count={count('ai').length}>
          {count('ai').map((next, index) => <Item key={index} line={next} bar="border-l-primary" onFocus={() => pickLine(next)} label="Mostra dipendenze della scheda"><Draft next={next} /></Item>)}
        </Column>
        <Column title="You" tone="border-t-warning" icon={<User aria-hidden="true" className="size-4 text-warning" />} count={count('you').length}>
          {count('you').map((next, index) => <Item key={index} line={next} bar="border-l-warning" onFocus={() => pickLine(next)} label="Mostra dipendenze della scheda"><Draft next={next} /></Item>)}
        </Column>
        <Column title="Them" tone="border-t-info" icon={<Users aria-hidden="true" className="size-4 text-info" />} count={them.length}>
          {them.map((wait, index) =>
            <Item key={index} line={{ ...wait, text: `**${wait.who}**: ${wait.text}` }} bar={wait.days > OVERDUE_DAYS ? 'border-l-destructive' : 'border-l-info'} onFocus={() => explainer ? pickLine(wait) : pick(wait.who)} label={`Show what ${wait.who} owes`}>
              <span className={cn('mt-1 block text-xs', wait.days > OVERDUE_DAYS ? 'font-medium text-destructive' : 'text-muted-foreground')}>{wait.days === 0 ? `since ${dayMonth(wait.since)}` : `${wait.days} working day${wait.days === 1 ? '' : 's'}, since ${dayMonth(wait.since)}`}</span>
            </Item>)}
        </Column>
        <Column title="Done this week" tone="border-t-success" icon={<Check aria-hidden="true" className="size-4 text-success" />} count={summary.done.length}>
          {summary.done.map((line, index) => <Item key={index} line={line} bar="border-l-success" />)}
        </Column>
      </div>
    </>}
  </section>;
}

function NowList({ summary }: { summary: NonNullable<InitiativeView['summary']> }) {
  return <div>
    <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Now</h3>
    <ul className="space-y-2.5 text-[15px] leading-snug">{summary.now.map((line, index) => <li key={index} className="flex gap-2.5">
      <ArrowRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-primary" /><span><Text text={line.text} /><Sources sources={line.sources} /></span></li>)}</ul>
    <p className="mt-4 text-xs text-muted-foreground">
      {summary.entries} log entries read{summary.rejected ? `, ${summary.rejected} items dropped for citing no source` : ''}
    </p>
  </div>;
}

function signedOut(response: Response): boolean {
  if (response.status !== 401 || response.headers.get('x-everflow-login') !== 'required') return false;
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  return true;
}

export function InitiativesPage(props: { initialState: InitiativesState; token: string; signOut?: boolean }) {
  const [state, setState] = useState(props.initialState);
  const [selected, setSelected] = useState(props.initialState.initiatives[0]?.id ?? null);
  const [guides, setGuides] = useState<Record<string, GuideState>>({});
  const [error, setError] = useState('');
  const idsKey = state.initiatives.map((item) => item.id).join(',');
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/initiatives', { cache: 'no-store', credentials: 'same-origin' });
      if (signedOut(response)) return;
      if (response.ok) { setState(await response.json() as InitiativesState); setError(''); }
      else setError(`Overview unavailable (HTTP ${response.status})`);
    } catch { setError('Overview unreachable, retrying'); }
  }, []);
  const loadGuides = useCallback(async () => {
    const found = await Promise.all(idsKey.split(',').filter(Boolean).map(async (id) => {
      try {
        const response = await fetch(`/api/guide/${encodeURIComponent(id)}`, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return null;
        const guide = await response.json() as GuideState | null;
        return guide && typeof guide === 'object' ? [id, guide] as const : null;
      } catch { return null; }
    }));
    setGuides(Object.fromEntries(found.filter((entry) => !!entry)));
  }, [idsKey]);
  const post = useCallback(async (action: 'refresh' | 'seen') => {
    const response = await fetch(`/api/initiatives/${action}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-everflow-token': props.token }, body: '{}' });
    if (signedOut(response)) return;
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
    }
  }, [props.token]);
  useEffect(() => { void loadGuides(); }, [loadGuides]);
  useEffect(() => {
    const timer = setInterval(() => { void load(); void loadGuides(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load, loadGuides]);
  useEffect(() => {
    const key = 'everflow.overview.seen';
    if (window.sessionStorage.getItem(key) === state.today) return;
    window.sessionStorage.setItem(key, state.today);
    void post('seen').catch(() => {});
  }, [post, state.today]);
  const busy = state.refreshing || state.requested;
  const view = state.initiatives.find((item) => item.id === selected) ?? state.initiatives[0];
  const updated = state.initiatives.map((item) => item.at).filter((at): at is string => !!at).sort().at(-1);
  return <div className="min-h-dvh">
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/apple-icon.png" alt="" aria-hidden="true" className="size-9 object-contain" />
          <div className="leading-tight">
            <h1 className="text-[15px] font-semibold tracking-tight">Everflow</h1>
            <p className="text-xs text-muted-foreground">Overview · {formatDate(state.today)}</p>
          </div>
        </div>
        <nav aria-label="Pages" className="flex gap-0.5 rounded-lg bg-muted p-0.5 text-sm">
          <a href="/" className="rounded-md px-3 py-1 text-muted-foreground hover:text-foreground">Board</a>
          <a href="/overview" aria-current="page" className="rounded-md bg-card px-3 py-1 font-medium shadow-xs">Overview</a>
        </nav>
        <p className="text-xs text-muted-foreground sm:ml-auto">{busy ? 'Refreshing…' : updated ? `Updated ${formatTime(updated)}` : 'Not refreshed yet'}</p>
        <Button type="button" variant="outline" size="sm" disabled={busy || !state.initiatives.length || !state.providers}
          onClick={() => { void post('refresh').then(load, (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))); }}>
          <RefreshCw aria-hidden="true" className={cn(busy && 'animate-spin')} />Refresh</Button>
        {props.signOut && <Button variant="ghost" size="sm" className="text-muted-foreground"
          onClick={() => { void fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then((r) => r.headers.get('x-everflow-logout') ?? '/login', () => '/login').then((to) => window.location.assign(to)); }}>
          <LogOut aria-hidden="true" />Sign out</Button>}
      </div>
    </header>
    <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-5 sm:px-6 sm:py-6">
      {error && <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
      {!state.initiatives.length ? <Alert>
        <LayoutGrid aria-hidden="true" />
        <AlertTitle>No initiative switched on</AlertTitle>
        <AlertDescription>Add an [initiatives.&lt;id&gt;] entry with title, client and vault note to the instance config.</AlertDescription>
      </Alert> : <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {state.initiatives.map((item) => {
            const summary = item.summary;
            const count = (owner: 'ai' | 'you') => summary?.next.filter((next) => next.owner === owner).length ?? 0;
            return <div key={item.id} data-selected={item.id === view?.id}
              className="flex flex-col rounded-xl border bg-card shadow-xs transition-colors hover:border-foreground/20 data-[selected=true]:border-primary data-[selected=true]:ring-1 data-[selected=true]:ring-primary">
              <button type="button" aria-pressed={item.id === view?.id} onClick={() => setSelected(item.id)} className="flex flex-1 flex-col gap-2 rounded-t-xl p-3.5 text-left">
                <span className="text-[11px] tracking-wide text-muted-foreground uppercase">{item.client}</span>
                <span className="text-[15px] font-semibold">{item.title}</span>
                <StatePill view={item} />
                {summary && <span className="line-clamp-2 text-xs text-muted-foreground"><Text text={summary.headline} /></span>}
                {item.error && <span className="inline-flex items-center gap-1 text-[11px] text-destructive"><TriangleAlert aria-hidden="true" className="size-3" />Last refresh failed</span>}
                {summary && <span className="flex gap-3 text-[11px] text-muted-foreground">
                  <span>You <b className="text-foreground">{count('you')}</b></span>
                  <span>Them <b className="text-foreground">{summary.waits.filter((wait) => wait.owes === 'them').length}</b></span>
                  <span>AI <b className="text-foreground">{count('ai')}</b></span>
                </span>}
              </button>
              <div className="border-t px-3.5 py-2"><GuideLink id={item.id} ready={!!guides[item.id]?.explainer} size="card" /></div>
            </div>;
          })}
        </div>
        {view && <Detail key={view.id} view={view} guide={guides[view.id] ?? null} />}
      </>}
    </main>
  </div>;
}
