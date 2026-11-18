'use client';

import { Bot, Check, ChevronDown, ChevronUp, Copy, LayoutGrid, LogOut, RefreshCw, TriangleAlert, User, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { InitiativeLine, InitiativeNext, InitiativeSource, InitiativesState, InitiativeStateName, InitiativeView, InitiativeWait } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Inline } from '../tickets/markdown.tsx';
import { formatTime } from '../tickets/ticket-card.tsx';

const POLL_MS = 15_000;
// Waits on others older than this many working days turn red
export const OVERDUE_DAYS = 5;

function themDays(view: InitiativeView): number {
  return Math.max(0, ...(view.summary?.waits ?? []).filter((wait) => wait.owes === 'them').map((wait) => wait.days));
}

const stateLabels: Record<InitiativeStateName, string> = { moving: 'Moving', waiting_them: 'Waiting on them', needs_you: 'Needs you', stuck: 'Stuck', quiet: 'Quiet' };

function StatePill({ view }: { view: InitiativeView }) {
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

function Sources({ sources }: { sources: InitiativeSource[] }) {
  const [open, setOpen] = useState(false);
  const newest = sources.at(-1)!;
  return <span className="ml-1 inline">
    <button type="button" aria-expanded={open} title={sources.map((source) => source.text).join('\n\n')} onClick={() => setOpen(!open)}
      aria-label={`Sources (${sources.length})`}
      className="rounded bg-muted px-1 font-mono text-[10px] whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-accent-foreground">
      {newest.date.slice(5)}{sources.length > 1 ? ` +${sources.length - 1}` : ''}
    </button>
    {open && <span role="note" className="mt-1 block space-y-1 rounded-md border bg-background p-2 text-[11px] leading-snug text-muted-foreground">
      {sources.map((source) => <span key={source.id} className="block"><span className="font-mono">{source.id}</span> {source.text}</span>)}
    </span>}
  </span>;
}

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

type Person = { who: string; waits: InitiativeWait[]; tone: 'overdue' | 'them' | 'you' };
const strokes = { overdue: 'var(--destructive)', them: 'var(--info)', you: 'var(--warning)' };

// Who owes what: each person around Antonio, arrows the way the missing piece has to travel
export function PeopleMap({ waits }: { waits: InitiativeWait[] }) {
  const people: Person[] = [];
  for (const wait of waits) {
    let person = people.find((item) => item.who.toLowerCase() === wait.who.toLowerCase());
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
  return <svg role="img" aria-label={`Open requests: ${placed.map((person) => `${person.who} ${person.waits.length}`).join(', ')}`} viewBox={`0 0 ${width} ${height}`}
    className="h-[280px] w-full rounded-lg bg-background">
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
      return <g key={person.who} data-person={person.who} data-tone={person.tone}>
        <title>{person.waits.map((wait) => `${wait.owes === 'you' ? 'You owe' : 'Owes you'}: ${wait.text} (${wait.days} working days)\n${wait.sources.map((source) => source.text).join('\n')}`).join('\n\n')}</title>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={strokes[person.tone]} strokeWidth={2} strokeDasharray="6 4" markerEnd={`url(#arrow-${person.tone})`}
          className="animate-[dash-flow_1.2s_linear_infinite]" />
        {person.tone === 'overdue' && <circle cx={person.x} cy={person.y} r={node} fill="var(--destructive)" className="origin-center animate-[node-pulse_1.8s_ease-out_infinite] [transform-box:fill-box]" />}
        <circle cx={person.x} cy={person.y} r={node} fill="var(--card)" stroke={strokes[person.tone]} strokeWidth={2} />
        <text x={person.x} y={person.y + 3.5} textAnchor="middle" fontSize="10" fill="var(--foreground)">{initials(person.who)}</text>
        <text x={person.x} y={below ? person.y + node + 13 : person.y - node - 18} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--foreground)">{person.who}</text>
        <text x={person.x} y={below ? person.y + node + 25 : person.y - node - 6} textAnchor="middle" fontSize="10" fontWeight="600" fill={strokes[person.tone]}>{label}</text>
      </g>;
    })}
    <circle cx={cx} cy={cy} r={center} fill="var(--primary)" />
    <text x={cx} y={cy + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--primary-foreground)">You</text>
  </svg>;
}

function Draft({ next }: { next: InitiativeNext }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!next.draft) return null;
  return <div className="mt-1.5">
    <div className="flex gap-1">
      <Button type="button" variant="outline" size="xs" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}Draft</Button>
      <Button type="button" variant="outline" size="xs" onClick={() => { void navigator.clipboard?.writeText(next.draft!).then(() => setCopied(true)); }}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? 'Copied' : 'Copy'}</Button>
    </div>
    {open && <pre className="mt-1.5 rounded-md border bg-card p-2 font-sans text-[11px] whitespace-pre-wrap">{next.draft}</pre>}
  </div>;
}

function Column(props: { title: string; icon: React.ReactNode; count: number; children: React.ReactNode }) {
  return <section aria-label={`${props.title} (${props.count})`} className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-muted/80 p-2 ring-1 ring-border/60">
    <h3 className="flex items-center gap-1.5 px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{props.icon}{props.title}
      <span className="ml-auto rounded-full bg-background px-1.5 tabular-nums">{props.count}</span></h3>
    {props.count === 0 && <p className="px-1 py-3 text-center text-xs text-muted-foreground">Nothing.</p>}
    {props.children}
  </section>;
}

function Item({ line, bar, children }: { line: InitiativeLine; bar: string; children?: React.ReactNode }) {
  return <div className={cn('rounded-md border border-l-[3px] bg-card px-2 py-1.5 text-xs leading-snug', bar)}>
    <Inline text={line.text} /><Sources sources={line.sources} />
    {children}
  </div>;
}

function Detail({ view }: { view: InitiativeView }) {
  const summary = view.summary;
  return <section aria-label={`${view.client} ${view.title}`} className="space-y-3 rounded-xl border bg-card p-3 shadow-xs sm:p-4">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-base font-semibold"><span className="mr-1.5 text-[11px] font-normal tracking-wide text-muted-foreground uppercase">{view.client}</span>{view.title}</h2>
      <StatePill view={view} />
      <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground" title="Vault note">{view.note}</span>
    </div>
    {view.error && <Alert variant="destructive" className="border-destructive/30 bg-destructive-soft">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Last refresh failed{view.error_at ? ` at ${formatTime(view.error_at)}` : ''}</AlertTitle>
      <AlertDescription>{view.error}{summary && view.at ? `. Showing the summary of ${formatTime(view.at)}.` : ''}</AlertDescription>
    </Alert>}
    {!summary ? <p className="py-6 text-center text-sm text-muted-foreground">No summary yet. Refresh to build it from the note.</p> : <>
      <p className="text-sm font-medium"><Inline text={summary.headline} /></p>
      <div className="grid items-start gap-3 lg:grid-cols-[1.1fr_1fr]">
        <PeopleMap waits={summary.waits} />
        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Now</h3>
          <ul className="space-y-1.5 text-sm">{summary.now.map((line, index) => <li key={index}><Inline text={line.text} /><Sources sources={line.sources} /></li>)}</ul>
          <p className="mt-3 text-[11px] text-muted-foreground">
            {summary.entries} log entries read{summary.rejected ? `, ${summary.rejected} items dropped for citing no source` : ''}{view.at ? `, updated ${formatTime(view.at)}` : ''}
          </p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Column title="AI" icon={<Bot aria-hidden="true" className="size-3.5" />} count={summary.next.filter((next) => next.owner === 'ai').length}>
          {summary.next.filter((next) => next.owner === 'ai').map((next, index) => <Item key={index} line={next} bar="border-l-primary"><Draft next={next} /></Item>)}
        </Column>
        <Column title="You" icon={<User aria-hidden="true" className="size-3.5" />} count={summary.next.filter((next) => next.owner === 'you').length}>
          {summary.next.filter((next) => next.owner === 'you').map((next, index) => <Item key={index} line={next} bar="border-l-warning"><Draft next={next} /></Item>)}
        </Column>
        <Column title="Them" icon={<Users aria-hidden="true" className="size-3.5" />} count={summary.waits.filter((wait) => wait.owes === 'them').length}>
          {summary.waits.filter((wait) => wait.owes === 'them').sort((a, b) => b.days - a.days).map((wait, index) =>
            <Item key={index} line={{ ...wait, text: `**${wait.who}**: ${wait.text}` }} bar={wait.days > OVERDUE_DAYS ? 'border-l-destructive' : 'border-l-info'}>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{wait.days === 0 ? 'today' : `${wait.days} working day${wait.days === 1 ? '' : 's'}`}</span>
            </Item>)}
        </Column>
        <Column title="Done this week" icon={<Check aria-hidden="true" className="size-3.5" />} count={summary.done.length}>
          {summary.done.map((line, index) => <Item key={index} line={line} bar="border-l-success" />)}
        </Column>
      </div>
    </>}
  </section>;
}

function signedOut(response: Response): boolean {
  if (response.status !== 401 || response.headers.get('x-everflow-login') !== 'required') return false;
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  return true;
}

export function InitiativesPage(props: { initialState: InitiativesState; token: string; signOut?: boolean }) {
  const [state, setState] = useState(props.initialState);
  const [selected, setSelected] = useState(props.initialState.initiatives[0]?.id ?? null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/initiatives', { cache: 'no-store', credentials: 'same-origin' });
      if (signedOut(response)) return;
      if (response.ok) { setState(await response.json() as InitiativesState); setError(''); }
      else setError(`Overview unavailable (HTTP ${response.status})`);
    } catch { setError('Overview unreachable, retrying'); }
  }, []);
  const post = useCallback(async (action: 'refresh' | 'seen') => {
    const response = await fetch(`/api/initiatives/${action}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-everflow-token': props.token }, body: '{}' });
    if (signedOut(response)) return;
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
    }
  }, [props.token]);
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
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
            <p className="text-xs text-muted-foreground">Overview · {state.today}</p>
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
          onClick={() => { void fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).finally(() => window.location.assign('/login')); }}>
          <LogOut aria-hidden="true" />Sign out</Button>}
      </div>
    </header>
    <main className="mx-auto max-w-[1600px] space-y-3 px-4 py-4 sm:px-6 sm:py-5">
      {error && <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
      {!state.initiatives.length ? <Alert>
        <LayoutGrid aria-hidden="true" />
        <AlertTitle>No initiative switched on</AlertTitle>
        <AlertDescription>Add an [initiatives.&lt;id&gt;] entry with title, client and vault note to the instance config.</AlertDescription>
      </Alert> : <>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {state.initiatives.map((item) => {
            const summary = item.summary;
            const count = (owner: 'ai' | 'you') => summary?.next.filter((next) => next.owner === owner).length ?? 0;
            return <button key={item.id} type="button" aria-pressed={item.id === view?.id} onClick={() => setSelected(item.id)}
              className="flex flex-col gap-1.5 rounded-xl border bg-card p-3 text-left shadow-xs transition-colors hover:border-foreground/20 aria-pressed:border-primary aria-pressed:ring-1 aria-pressed:ring-primary">
              <span className="text-[11px] tracking-wide text-muted-foreground uppercase">{item.client}</span>
              <span className="text-sm font-semibold">{item.title}</span>
              <StatePill view={item} />
              {summary && <span className="line-clamp-2 text-xs text-muted-foreground"><Inline text={summary.headline} /></span>}
              {item.error && <span className="inline-flex items-center gap-1 text-[11px] text-destructive"><TriangleAlert aria-hidden="true" className="size-3" />Last refresh failed</span>}
              {summary && <span className="flex gap-3 text-[11px] text-muted-foreground">
                <span>You <b className="text-foreground">{count('you')}</b></span>
                <span>Them <b className="text-foreground">{summary.waits.filter((wait) => wait.owes === 'them').length}</b></span>
                <span>AI <b className="text-foreground">{count('ai')}</b></span>
              </span>}
            </button>;
          })}
        </div>
        {view && <Detail view={view} />}
      </>}
    </main>
  </div>;
}
