'use client';

import { Bot, ChevronDown, CircleCheck, Cpu, Inbox, RotateCw, Ticket, TriangleAlert, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { groups } from '../../lib/web-types.ts';
import type { Health, OverviewState } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Time } from './ticket-card.tsx';

type State = Health['state'];
type Post = (key: string, path: string) => Promise<unknown>;

const rank: Record<State, number> = { failing: 5, stopped: 4, retrying: 3, unknown: 2, disabled: 1, ok: 0 };
const dot: Record<State, string> = {
  ok: 'bg-success', retrying: 'bg-warning', failing: 'bg-destructive', stopped: 'bg-destructive', unknown: 'bg-input', disabled: 'bg-input',
};
const stroke: Record<State, string> = {
  ok: 'var(--success)', retrying: 'var(--warning)', failing: 'var(--destructive)', stopped: 'var(--destructive)', unknown: 'var(--input)', disabled: 'var(--input)',
};

function worstOf(states: State[]): State {
  if (!states.length) return 'unknown';
  return states.reduce<State>((current, next) => rank[next] > rank[current] ? next : current, 'ok');
}
const worst = (items: Health[]) => worstOf(items.map((item) => item.state));
const label = (state: State) => state === 'unknown' ? 'not used yet' : state === 'disabled' ? 'off' : state;

function Dot({ state, className }: { state: State; className?: string }) {
  return <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', dot[state], state === 'retrying' && 'animate-pulse', className)} />;
}

function Row({ name, item }: { name: string; item: Health }) {
  const hint = [item.since && item.state !== 'ok' ? `Since ${item.since}` : '', item.last_ok ? `Last ok ${item.last_ok}` : '', item.checkpoint ? `Checkpoint ${item.checkpoint}` : ''].filter(Boolean).join('\n');
  return <li className="min-w-0 py-1" title={hint || undefined}>
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <Dot state={item.state} />
      <span className="min-w-0 truncate">{name}</span>
      <span className="ml-auto shrink-0 text-muted-foreground">{label(item.state)}</span>
    </div>
    {item.last_error && <p className="mt-0.5 line-clamp-2 pl-4 text-[11px] leading-snug text-destructive">{item.last_error}</p>}
    {item.checkpoint && <p className="pl-4 text-[11px] text-muted-foreground">{item.coverage === 'recent-topics' ? 'Latest stored' : 'Checkpoint'} <Time value={item.checkpoint} /></p>}
  </li>;
}

function Issue({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning ring-1 ring-warning/25 hover:ring-warning/60">
    <TriangleAlert aria-hidden="true" className="size-3" />{children}
  </a>;
}

function Node(props: { id: string; title: string; icon: React.ReactNode; state: State; status?: string | undefined; children?: React.ReactNode; issues?: React.ReactNode[] }) {
  return <div data-node={props.id} className={cn('relative z-10 min-w-0 rounded-lg border bg-card px-3 py-2.5 shadow-xs',
    (props.state === 'failing' || props.state === 'stopped') && 'border-destructive/30', props.state === 'retrying' && 'border-warning/40')}>
    <div className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">{props.icon}</span>
      <h3 className="min-w-0 truncate text-sm font-semibold">{props.title}</h3>
      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><Dot state={props.state} />{props.status ?? label(props.state)}</span>
    </div>
    {props.children}
    {props.issues?.some(Boolean) && <div className="mt-2 flex flex-wrap gap-1">{props.issues}</div>}
  </div>;
}

function Stage({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
    <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
    {children}
  </div>;
}

export function Pipeline({ state }: { state: OverviewState }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const [paths, setPaths] = useState<{ key: string; d: string; state: State; end: [number, number] }[]>([]);
  const health = state.health;
  const sources = health.filter((item) => item.scope === 'source');
  const accounts = health.filter((item) => item.scope === 'account');
  const known = new Set(sources.map((item) => item.dependency));
  const orphans = [...new Set(accounts.map((item) => item.dependency.split(':')[0]!).filter((name) => !known.has(name)))];
  const listed = [
    ...sources.map((source) => ({ name: source.dependency, source: source as Health | null, accounts: accounts.filter((item) => item.dependency.startsWith(`${source.dependency}:`)) })),
    ...orphans.map((name) => ({ name, source: null as Health | null, accounts: accounts.filter((item) => item.dependency.startsWith(`${name}:`)) })),
  ].map((input) => {
    const live = input.accounts.filter((item) => item.state !== 'disabled');
    return { ...input, live, off: input.accounts.filter((item) => item.state === 'disabled'), state: worst([...(input.source ? [input.source] : []), ...live]),
      quarantine: state.problems.quarantine.filter((item) => item.source === input.name) };
  });
  const inputs = listed.filter((input) => input.source?.state !== 'disabled');
  const switchedOff = listed.filter((input) => input.source?.state === 'disabled').map((input) => input.name);
  const daemon = health.filter((item) => item.scope === 'daemon');
  const maintenance = health.filter((item) => item.scope === 'jobs' && item.dependency !== 'tickets');
  const providers = health.filter((item) => item.scope === 'provider');
  const openchamber = health.filter((item) => item.scope === 'openchamber');
  const strayQuarantine = state.problems.quarantine.filter((item) => !inputs.some((input) => input.name === item.source));
  const triageJobs = state.problems.jobs.filter((job) => job.kind === 'triage');
  const chatJobs = state.problems.jobs.filter((job) => job.kind !== 'triage');
  const daemonState = worst([...daemon, ...maintenance]);
  const triageState = worst(providers);
  const chatState = state.chats_enabled ? worst(openchamber) : 'disabled';
  const ticketCount = Object.values(state.groups).reduce((sum, list) => sum + list.length, 0);
  const edges: [string, string, State][] = [
    ...inputs.map((input, index): [string, string, State] => [`input-${index}`, 'daemon', input.state]),
    ['daemon', 'triage', daemonState], ['triage', 'tickets', triageState], ['tickets', 'openchamber', chatState],
  ];
  const signature = JSON.stringify([edges, worstOf(inputs.map((input) => input.state))]);

  useEffect(() => {
    const root = box.current;
    if (!root) return;
    const [plan, inputsState] = JSON.parse(signature) as [[string, string, State][], State];
    const draw = () => {
      const base = root.getBoundingClientRect();
      const rect = (id: string) => root.querySelector(`[data-node="${id}"]`)?.getBoundingClientRect();
      const group = rect('inputs');
      const first = rect('daemon');
      const vertical = !!group && !!first && first.top >= group.bottom - 1;
      const list: [string, string, State][] = vertical ? [['inputs', 'daemon', inputsState], ...plan.filter(([from]) => !from.startsWith('input-'))] : plan;
      setPaths(list.flatMap(([from, to, edge]) => {
        const a = rect(from);
        const b = rect(to);
        if (!a || !b || !a.width || !b.width) return [];
        if (vertical) {
          const [x1, y1, x2, y2] = [a.left + a.width / 2 - base.left, a.bottom - base.top, b.left + b.width / 2 - base.left, b.top - base.top];
          const middle = (y1 + y2) / 2;
          return [{ key: `${from}-${to}`, d: `M${x1},${y1} C${x1},${middle} ${x2},${middle} ${x2},${y2}`, state: edge, end: [x2, y2] as [number, number] }];
        }
        const [x1, y1, x2, y2] = [a.right - base.left, a.top + a.height / 2 - base.top, b.left - base.left, b.top + b.height / 2 - base.top];
        const middle = (x1 + x2) / 2;
        return [{ key: `${from}-${to}`, d: `M${x1},${y1} C${middle},${y1} ${middle},${y2} ${x2},${y2}`, state: edge, end: [x2, y2] as [number, number] }];
      }));
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(root);
    for (const node of root.querySelectorAll('[data-node]')) observer.observe(node);
    return () => observer.disconnect();
  }, [signature, open]);

  const summary: [string, State][] = [['Inputs', worstOf(inputs.map((input) => input.state))], ['Daemon', daemonState], ['Triage', triageState], ['Chats', chatState]];
  return <section aria-label="Health" className="rounded-xl border bg-card/60 p-4">
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', open && 'mb-3')}>
      <h2 className="text-sm font-semibold">Pipeline</h2>
      {open ? <p className="hidden text-xs text-muted-foreground sm:block">Inputs flow through the daemon and triage into tickets and approved chats.</p>
        : <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{summary.map(([name, value]) => <li key={name} className="inline-flex items-center gap-1.5"><Dot state={value} />{name}</li>)}</ul>}
      <Button type="button" variant="ghost" size="sm" className="ml-auto h-8 text-muted-foreground" aria-expanded={open} aria-controls={open ? 'pipeline-diagram' : undefined} onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'}<ChevronDown aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
      </Button>
    </div>
    {open && <div ref={box} id="pipeline-diagram" className="relative flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(230px,1.4fr)_repeat(4,minmax(150px,1fr))] lg:items-center lg:gap-x-12">
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full overflow-visible">
        {paths.map((path) => <g key={path.key}>
          <path d={path.d} fill="none" stroke={stroke[path.state]} strokeOpacity={path.state === 'ok' ? 0.25 : 0.35} strokeWidth={6} strokeLinecap="round" />
          <path d={path.d} fill="none" stroke={stroke[path.state]} strokeWidth={1.5} strokeLinecap="round"
            strokeDasharray={path.state === 'ok' ? '4 6' : '2 5'} className={path.state === 'ok' ? 'animate-[dash-flow_1.2s_linear_infinite]' : undefined} />
          <circle cx={path.end[0]} cy={path.end[1]} r={3} fill="var(--card)" stroke={stroke[path.state]} strokeWidth={1.5} />
        </g>)}
      </svg>

      <Stage label={`Inputs (${inputs.length})`}>
        <div data-node="inputs" className="flex flex-col gap-2 sm:grid sm:grid-cols-2 lg:flex">
          {inputs.map((input, index) => <Node key={input.name} id={`input-${index}`} title={input.name} icon={<Inbox />} state={input.state}
            issues={[input.quarantine.length > 0 && <Issue key="q" href={`#problem-quarantine-${input.quarantine[0]!.id}`}>{input.quarantine.length} quarantined</Issue>]}>
            {input.source?.coverage === 'recent-topics' && <p className="mt-1.5 text-[11px] text-warning">Recent topics only{input.source.observed_at && <>. Observed <Time value={input.source.observed_at} /></>}</p>}
            {(input.source?.last_error || input.accounts.length > 0) && <ul className="mt-1.5 divide-y divide-border/60">
              {input.source?.last_error && <li className="py-1"><p className="line-clamp-2 text-[11px] leading-snug text-destructive">{input.source.last_error}</p></li>}
              {input.live.map((item) => <Row key={item.dependency} name={item.dependency.slice(input.name.length + 1)} item={item} />)}
              {input.off.length > 0 && <li className="py-1"><details className="group">
                <summary className="inline-flex cursor-pointer items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground">{input.off.length} account{input.off.length === 1 ? '' : 's'} off<ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180" /></summary>
                <ul className="mt-1 divide-y divide-border/60">{input.off.map((item) => <Row key={item.dependency} name={item.dependency.slice(input.name.length + 1)} item={item} />)}</ul>
              </details></li>}
            </ul>}
          </Node>)}
          {inputs.length === 0 && <p className="rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground">No sources enabled.</p>}
          {switchedOff.length > 0 && <p className="px-1 text-[11px] text-muted-foreground">Off: {switchedOff.join(', ')}</p>}
        </div>
      </Stage>

      <Stage label="Collect">
        <Node id="daemon" title="Daemon" icon={<Cpu />} state={daemonState}
          issues={[strayQuarantine.length > 0 && <Issue key="q" href={`#problem-quarantine-${strayQuarantine[0]!.id}`}>{strayQuarantine.length} quarantined</Issue>]}>
          <ul className="mt-1.5 divide-y divide-border/60">
            {daemon.map((item) => <Row key={item.dependency} name="Collector" item={item} />)}
            {maintenance.map((item) => <Row key={item.dependency} name={item.dependency.replace(/^jobs:/, '')} item={item} />)}
          </ul>
        </Node>
      </Stage>

      <Stage label="Triage">
        <Node id="triage" title="Triage" icon={<Workflow />} state={triageState}
          issues={[
            state.problems.triage.length > 0 && <Issue key="invalid" href={`#problem-triage-${state.problems.triage[0]!.id}`}>{state.problems.triage.length} invalid</Issue>,
            triageJobs.length > 0 && <Issue key="parked" href={`#problem-job-${triageJobs[0]!.id}`}>{triageJobs.length} parked</Issue>,
          ]}>
          <ul className="mt-1.5 divide-y divide-border/60">
            {providers.map((item) => <Row key={item.dependency} name={item.dependency.replace(/^provider:/, '')} item={item} />)}
            {providers.length === 0 && <li className="py-1 text-xs text-muted-foreground">No providers configured.</li>}
          </ul>
        </Node>
      </Stage>

      <Stage label="Tickets">
        <Node id="tickets" title="Tickets" icon={<Ticket />} state={state.tickets_enabled ? 'ok' : 'disabled'} status={state.tickets_enabled ? `${ticketCount} today` : 'read-only'}>
          <ul className="mt-1.5 grid gap-0.5">
            {groups.map(([group, label]) => {
              const count = group === 'skipped' ? state.skipped.length : state.groups[group].length;
              return <li key={group}><a href={`#col-${group}`} className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted">
                <span className="min-w-0 truncate text-muted-foreground">{label}</span>
                <span className={cn('ml-auto font-semibold tabular-nums', count > 0 && group === 'failed' && 'text-destructive', count > 0 && group === 'needs_you' && 'text-primary')}>{count}</span>
              </a></li>;
            })}
          </ul>
        </Node>
      </Stage>

      <Stage label="Chats">
        <Node id="openchamber" title="OpenChamber" icon={<Bot />} state={chatState} status={state.chats_enabled ? undefined : 'Chats disabled'}
          issues={[chatJobs.length > 0 && <Issue key="parked" href={`#problem-job-${chatJobs[0]!.id}`}>{chatJobs.length} parked</Issue>]}>
          <ul className="mt-1.5 divide-y divide-border/60">
            {openchamber.map((item) => <Row key={item.dependency} name={item.dependency === 'opencode' ? 'Server' : item.dependency.replace(/^opencode:/, '')} item={item} />)}
          </ul>
        </Node>
      </Stage>
    </div>}
  </section>;
}

function Raw({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="group mt-1">
    <summary className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground">{label}<ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180" /></summary>
    <pre className="mt-1.5 max-h-60 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">{children}</pre>
  </details>;
}

function Problem(props: { id: string; stage: string; title: string; at: string; error?: string | null; detail?: string | null; raw?: string | null; rawLabel?: string;
  alert?: string | undefined; children?: React.ReactNode }) {
  return <li id={props.id} className="flex min-w-0 scroll-mt-28 items-start gap-3 rounded-lg border bg-card px-3 py-2 target:ring-2 target:ring-warning/60">
    <div className="min-w-0 flex-1 text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="rounded bg-muted px-1.5 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{props.stage}</span>
        <span className="font-medium">{props.title}</span>
        <span className="text-xs text-muted-foreground"><Time value={props.at} /></span>
      </p>
      {props.error && <p className="mt-0.5 text-destructive">{props.error}</p>}
      {props.detail && <p>{props.detail}</p>}
      {props.raw && <Raw label={props.rawLabel ?? 'Raw output'}>{props.raw}</Raw>}
      {props.alert && <p role="alert" className="mt-1 text-destructive">{props.alert}</p>}
    </div>
    {props.children}
  </li>;
}

export function Problems(props: { state: OverviewState; expired: boolean; pending: ReadonlySet<string>; errors: Record<string, string>; post: Post }) {
  const { jobs, quarantine, triage } = props.state.problems;
  const count = jobs.length + quarantine.length + triage.length;
  const [open, setOpen] = useState(true);
  return <section aria-label="Problems" className={cn('rounded-xl border p-3', count > 0 ? 'border-warning/30 bg-warning-soft/40' : 'bg-card/60')}>
    <div className="flex items-center gap-2">
      {count > 0 ? <TriangleAlert aria-hidden="true" className="size-4 text-warning" /> : <CircleCheck aria-hidden="true" className="size-4 text-success" />}
      <h2 className="text-sm font-semibold">Problems</h2>
      <span className={cn('rounded-full px-1.5 text-xs font-semibold tabular-nums', count > 0 ? 'bg-warning text-white' : 'bg-muted text-muted-foreground')}>{count}</span>
      {count === 0 && <p className="text-sm text-muted-foreground">No recorded problems.</p>}
      {count > 0 && <p className="hidden text-xs text-muted-foreground sm:block">{jobs.length} parked · {quarantine.length} quarantined · {triage.length} invalid triage</p>}
      {count > 0 && <Button type="button" variant="ghost" size="sm" className="ml-auto h-8 text-muted-foreground" aria-expanded={open} aria-controls={open ? 'problem-list' : undefined} onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'}<ChevronDown aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
      </Button>}
    </div>
    {count > 0 && open && <ul id="problem-list" className="mt-2.5 grid gap-2 lg:grid-cols-2">
      {jobs.map((job) => <Problem key={`job:${job.id}`} id={`problem-job-${job.id}`} stage={job.kind === 'triage' ? 'Triage' : 'Chat'}
        title={`${job.ticket === null ? 'Unbound job' : 'Job'} #${job.id} · ${job.kind}${job.ticket === null ? '' : ` · Ticket #${job.ticket}`}`}
        at={job.updated_at} error={job.last_error} detail={job.parse_error} raw={job.raw} alert={props.errors[`job:${job.id}:retry`]}>
        {props.state.tickets_enabled && <Button variant="outline" size="sm" type="button" className="h-10 bg-card sm:h-8" aria-label={`Retry job #${job.id}`} disabled={props.expired || props.pending.has(`job:${job.id}:retry`)}
          onClick={() => { void props.post(`job:${job.id}:retry`, `/api/job/${job.id}/retry`).catch(() => {}); }}>
          <RotateCw aria-hidden="true" className={cn(props.pending.has(`job:${job.id}:retry`) && 'animate-spin')} />Retry
        </Button>}
      </Problem>)}
      {quarantine.map((item) => <Problem key={`quarantine:${item.id}`} id={`problem-quarantine-${item.id}`} stage="Input" title={`Quarantine #${item.id} · ${item.source}`} at={item.at}
        error={item.error} raw={item.line} rawLabel={item.truncated ? 'Saved line (input truncated)' : 'Saved line'} />)}
      {triage.map((item) => <Problem key={`triage:${item.id}`} id={`problem-triage-${item.id}`} stage="Triage" title={`Triage failure #${item.id}${item.batch === null ? '' : ` · Batch #${item.batch}`}`}
        at={item.at} error={item.parse_error} raw={item.raw} />)}
    </ul>}
  </section>;
}
