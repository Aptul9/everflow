'use client';

import { Bot, ChevronDown, CircleCheck, CirclePause, Cpu, Inbox, LoaderCircle, RotateCw, Ticket, TriangleAlert, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { groups } from '../../lib/web-types.ts';
import type { Agent, Health, OverviewState } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Time } from './ticket-card.tsx';

type State = Health['state'];
type Post = (key: string, path: string) => Promise<unknown>;
type PausePost = (key: string, path: string, input: Record<string, string | boolean>) => Promise<unknown>;
type Choice = OverviewState['models']['triage'];
type ModelOption = OverviewState['models']['options']['chat'][number];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Model and effort the next triage call or the next new ticket chat starts with; empty picks the config default
function ModelPicker(props: { scope: 'triage' | 'chat'; choice: Choice; options: ModelOption[]; disabled: boolean; post: PausePost; error?: string | undefined }) {
  const { scope, choice } = props;
  const list = props.options.some((option) => option.id === choice.model) ? props.options
    : [{ id: choice.model, name: choice.model, efforts: EFFORTS }, ...props.options];
  const efforts = list.find((option) => option.id === choice.model)?.efforts.length ? list.find((option) => option.id === choice.model)!.efforts : EFFORTS;
  const save = (key: string, value: string) => props.post(`setting:${key}`, '/api/setting', { key, value });
  const id = `${scope}-model`;
  return <div className="mt-2 border-t pt-2">
    <p className="mb-1 text-[11px] text-muted-foreground">{scope === 'triage' ? 'Next triage call' : 'Next new ticket chat'}</p>
    <div className="flex min-w-0 gap-1.5">
      <label htmlFor={id} className="sr-only">{scope === 'triage' ? 'Triage model' : 'Chat model'}</label>
      <select id={id} value={choice.model} disabled={props.disabled} title={choice.model}
        onChange={(event) => {
          const model = event.target.value;
          const next = list.find((option) => option.id === model)?.efforts ?? [];
          void (async () => {
            await save(`${scope}.model`, model === choice.default_model ? '' : model);
            if (choice.effort && next.length && !next.includes(choice.effort)) await save(`${scope}.effort`, '');
          })().catch(() => {});
        }}
        className="h-8 min-w-0 flex-1 truncate rounded-md border bg-card px-1.5 text-xs disabled:opacity-50">
        {list.map((option) => <option key={option.id} value={option.id}>{option.id === choice.default_model ? `${option.name} (default)` : option.name}</option>)}
      </select>
      <label htmlFor={`${id}-effort`} className="sr-only">{scope === 'triage' ? 'Triage effort' : 'Chat effort'}</label>
      <select id={`${id}-effort`} value={choice.effort ?? ''} disabled={props.disabled}
        onChange={(event) => { void save(`${scope}.effort`, event.target.value).catch(() => {}); }}
        className="h-8 shrink-0 rounded-md border bg-card px-1.5 text-xs disabled:opacity-50">
        <option value="">Default effort</option>
        {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
      </select>
    </div>
    {props.error && <p role="alert" className="mt-1 text-[11px] text-destructive">{props.error}</p>}
  </div>;
}

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

// Pausing an account holds its new messages before triage and chat forwards until it is switched back on
function Switch(props: { on: boolean; label: string; disabled: boolean; onChange: () => void }) {
  return <button type="button" role="switch" aria-checked={props.on} aria-label={props.label} disabled={props.disabled} onClick={props.onChange}
    title={props.on ? 'On: new messages go to triage. Click to pause.' : 'Paused: new messages wait here. Click to resume.'}
    className="-my-1 shrink-0 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
    <span aria-hidden="true" className={cn('flex h-4 w-7 items-center rounded-full p-0.5 transition-colors', props.on ? 'bg-success' : 'bg-input')}>
      <span className={cn('size-3 rounded-full bg-white shadow-xs transition-transform', props.on && 'translate-x-3')} />
    </span>
  </button>;
}

function Row({ name, item, toggle }: { name: string; item: Health; toggle?: { disabled: boolean; onChange: () => void; error?: string | undefined } }) {
  const hint = [item.since && item.state !== 'ok' ? `Since ${item.since}` : '', item.last_ok ? `Last ok ${item.last_ok}` : '', item.checkpoint ? `Checkpoint ${item.checkpoint}` : ''].filter(Boolean).join('\n');
  const paused = item.paused === true;
  return <li className="min-w-0 py-1" title={hint || undefined}>
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <Dot state={paused ? 'disabled' : item.state} />
      <span className={cn('min-w-0 truncate', paused && 'text-muted-foreground')}>{name}</span>
      <span className={cn('ml-auto shrink-0', paused ? 'font-medium text-warning' : 'text-muted-foreground')}>
        {paused ? `paused${item.waiting ? `, ${item.waiting} waiting` : ''}` : label(item.state)}</span>
      {toggle && <Switch on={!paused} label={`Triage ${name}`} disabled={toggle.disabled} onChange={toggle.onChange} />}
    </div>
    {item.last_error && <p className="mt-0.5 line-clamp-2 pl-4 text-[11px] leading-snug text-destructive">{item.last_error}</p>}
    {(item.checkpoint || item.clients?.length) && <p className="pl-4 text-[11px] text-muted-foreground">
      {item.clients?.length ? <span className="font-medium text-foreground/70">{item.clients.join(', ')}</span> : null}
      {item.clients?.length && item.checkpoint ? ' · ' : null}
      {item.checkpoint && <>{item.coverage === 'recent-topics' ? 'Latest stored' : 'Checkpoint'} <Time value={item.checkpoint} /></>}</p>}
    {toggle?.error && <p role="alert" className="pl-4 text-[11px] text-destructive">{toggle.error}</p>}
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

function Agents({ agents, kind }: { agents: Agent[]; kind: Agent['kind'] }) {
  const list = agents.filter((agent) => agent.kind === kind);
  if (!list.length) return null;
  return <ul className="mt-1.5 grid gap-0.5">
    {list.map((agent, index) => <li key={`${kind}-${agent.ticket ?? index}`} className="flex min-w-0 items-center gap-1.5 text-[11px] text-primary" title={agent.title ?? undefined}>
      <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin" />
      <span className="shrink-0 font-medium">{agent.clients.length ? agent.clients.join(', ') : 'no client'}</span>
      <span className="min-w-0 truncate text-muted-foreground">{agent.ticket === null ? '' : `#${agent.ticket} `}{agent.title ?? ''}</span>
    </li>)}
  </ul>;
}

export function Pipeline({ state, expired = false, pending = new Set(), errors = {}, post = async () => ({}) }: { state: OverviewState; expired?: boolean;
  pending?: ReadonlySet<string>; errors?: Record<string, string>; post?: PausePost }) {
  const box = useRef<HTMLDivElement>(null);
  // null until toggled: the diagram then follows health, folded while everything works
  const [open, setOpen] = useState<boolean | null>(null);
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
  // A fallback provider never called yet says nothing about a stage that already works
  const triageState = worst(providers.some((item) => item.state !== 'unknown') ? providers.filter((item) => item.state !== 'unknown') : providers);
  const chatState = state.chats_enabled ? worst(openchamber) : 'disabled';
  const ticketCount = Object.values(state.groups).reduce((sum, list) => sum + list.length, 0);
  const edges: [string, string, State][] = [
    ...inputs.map((input, index): [string, string, State] => [`input-${index}`, 'daemon', input.state]),
    ['daemon', 'triage', daemonState], ['triage', 'tickets', triageState], ['tickets', 'openchamber', chatState],
  ];
  const signature = JSON.stringify([edges, worstOf(inputs.map((input) => input.state))]);
  const summary: [string, State][] = [['Inputs', worstOf(inputs.map((input) => input.state))], ['Daemon', daemonState], ['Triage', triageState], ['Chats', chatState]];
  const { jobs, quarantine, triage } = state.problems;
  const problems = jobs.length + quarantine.length + triage.length;
  const healthy = problems === 0 && summary.every(([, value]) => rank[value] < rank.retrying);
  const shown = open ?? !healthy;
  const options = state.models.options;
  const asked = useRef(false);
  // Picker lists come from the daemon; ask it once per page when they are missing or older than 10 minutes
  useEffect(() => {
    if (!shown || asked.current || expired || !state.tickets_enabled || options.requested_at) return;
    if (options.at && Date.now() - Date.parse(options.at) < 600_000) return;
    asked.current = true;
    void post('setting:refresh', '/api/setting', { refresh: true }).catch(() => {});
  }, [shown, expired, state.tickets_enabled, options.at, options.requested_at, post]);
  const pickerError = (scope: 'triage' | 'chat') => errors[`setting:${scope}.model`] ?? errors[`setting:${scope}.effort`]
    ?? options.error?.split('; ').find((part) => part.startsWith(`${scope}:`));
  const pickerDisabled = expired || !state.tickets_enabled || [...pending].some((key) => key.startsWith('setting:'));
  const paused = accounts.filter((item) => item.paused);
  const toggle = (source: string, item: Health) => {
    const account = item.dependency.slice(source.length + 1);
    const key = `input:${item.dependency}`;
    return { disabled: expired || pending.has(key) || !state.tickets_enabled, error: errors[key],
      onChange: () => { void post(key, '/api/input', { source, account, paused: !item.paused }).catch(() => {}); } };
  };

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
  }, [signature, shown]);

  return <section aria-label="Health" className={cn('rounded-xl border bg-card/60', shown ? 'p-4' : 'px-4 py-2')}>
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', shown && 'mb-3')}>
      <h2 className="text-sm font-semibold">Pipeline</h2>
      {shown ? <p className="hidden text-xs text-muted-foreground sm:block">Inputs flow through the daemon and triage into tickets and approved chats.</p>
        : <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{summary.map(([name, value]) => <li key={name} className="inline-flex items-center gap-1.5"><Dot state={value} />{name}</li>)}
          <li className={cn('inline-flex items-center gap-1.5', problems > 0 && 'font-medium text-warning')}>
            {problems > 0 ? <TriangleAlert aria-hidden="true" className="size-3.5" /> : <CircleCheck aria-hidden="true" className="size-3.5 text-success" />}
            {problems > 0 ? `${problems} problem${problems === 1 ? '' : 's'}` : 'No problems'}
          </li>
          {state.agents.map((agent, index) => <li key={`agent-${index}`} className="inline-flex items-center gap-1.5 font-medium text-primary" title={agent.title ?? undefined}>
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />{agent.kind === 'triage' ? 'Triage' : `Chat #${agent.ticket}`} for {agent.clients.length ? agent.clients.join(', ') : 'no client'}
          </li>)}
          {paused.length > 0 && <li className="inline-flex items-center gap-1.5 font-medium text-warning"><CirclePause aria-hidden="true" className="size-3.5" />
            Paused: {paused.map((item) => `${item.clients?.length ? item.clients.join(', ') : item.dependency.split(':').slice(1).join(':')}${item.waiting ? ` (${item.waiting} waiting)` : ''}`).join(', ')}</li>}
        </ul>}
      <Button type="button" variant="ghost" size="sm" className="ml-auto h-8 text-muted-foreground" aria-expanded={shown} aria-controls={shown ? 'pipeline-diagram' : undefined} onClick={() => setOpen(!shown)}>
        {shown ? 'Hide' : 'Show'}<ChevronDown aria-hidden="true" className={cn('transition-transform', shown && 'rotate-180')} />
      </Button>
    </div>
    {shown && <div ref={box} id="pipeline-diagram" className="relative flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(230px,1.4fr)_repeat(4,minmax(150px,1fr))] lg:items-center lg:gap-x-12">
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
              {input.live.map((item) => <Row key={item.dependency} name={item.dependency.slice(input.name.length + 1)} item={item} toggle={toggle(input.name, item)} />)}
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
          <Agents agents={state.agents} kind="triage" />
          <ModelPicker scope="triage" choice={state.models.triage} options={options.triage} disabled={pickerDisabled} post={post} error={pickerError('triage')} />
        </Node>
      </Stage>

      <Stage label="Tickets">
        <Node id="tickets" title="Tickets" icon={<Ticket />} state={state.tickets_enabled ? 'ok' : 'disabled'} status={state.tickets_enabled ? `${ticketCount} today` : 'read-only'}>
          <ul className="mt-1.5 grid gap-0.5">
            {groups.map(([group, label]) => {
              const count = (group === 'skipped' ? state.skipped.length : 0) + state.groups[group].length;
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
          <Agents agents={state.agents} kind="chat" />
          <ModelPicker scope="chat" choice={state.models.chat} options={options.chat} disabled={pickerDisabled} post={post} error={pickerError('chat')} />
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
  // With nothing to fix, the pipeline status line already says so
  if (count === 0) return null;
  return <section aria-label="Problems" className="rounded-xl border border-warning/30 bg-warning-soft/40 p-3">
    <div className="flex items-center gap-2">
      <TriangleAlert aria-hidden="true" className="size-4 text-warning" />
      <h2 className="text-sm font-semibold">Problems</h2>
      <span className="rounded-full bg-warning px-1.5 text-xs font-semibold text-white tabular-nums">{count}</span>
      <p className="hidden text-xs text-muted-foreground sm:block">{jobs.length} parked · {quarantine.length} quarantined · {triage.length} invalid triage</p>
      <Button type="button" variant="ghost" size="sm" className="ml-auto h-8 text-muted-foreground" aria-expanded={open} aria-controls={open ? 'problem-list' : undefined} onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'}<ChevronDown aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
      </Button>
    </div>
    {open && <ul id="problem-list" className="mt-2.5 grid gap-2 lg:grid-cols-2">
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
