'use client';

import { ArrowLeft, Bell, BookOpen, Bot, Building2, ClipboardCheck, Clock, Cloud, Container, Database, Eye, FileText, Fingerprint, GitBranch, GitPullRequest, Hourglass, KeyRound, ListChecks, Lock, LogOut, Monitor, Network, RefreshCw, ScrollText, Server, Shield, ShieldAlert, Siren, Terminal, Ticket, TriangleAlert, User, Users, Vault, Workflow, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { guideItemKey } from '../../lib/web-types.ts';
import type { Explainer, ExplainerIcon, ExplainerItemStatus, ExplainerPerson, GuideState } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Inline } from '../tickets/markdown.tsx';
import { DependencyGraph, initials, workDays } from './dependency-graph.tsx';
import { Diagram } from './diagram.tsx';
import { GlossBack, GlossProvider, Glossed, useGloss } from './glossed.tsx';
import { StatePill } from './initiatives-page.tsx';
import { formatDate, formatInitiativeTime as formatTime, GuideSources } from './sources.tsx';

const POLL_MS = 10_000;

const sections = [
  ['breve', 'In breve'], ['perche', 'Perché esiste'], ['ruolo', 'Il tuo ruolo'], ['chi', 'Chi c\'è'], ['concetti', 'I concetti'], ['punto', 'A che punto siamo'],
  ['blocchi', 'Cosa blocca e sblocca'], ['storia', 'La storia'], ['chiedere', 'A chi chiedere cosa'], ['attenzione', 'Attenzione'], ['glossario', 'Glossario'],
] as const;

const teamTone: Record<Explainer['teams'][number]['kind'], string> = {
  client: 'border-info/40 bg-info-soft', us: 'border-primary/40 bg-accent', platform: 'border-border bg-muted', security: 'border-destructive/30 bg-destructive-soft',
  vendor: 'border-warning/40 bg-warning-soft', other: 'border-border bg-card',
};
const itemTone: Record<ExplainerItemStatus, [string, string]> = {
  done: ['fatto', 'bg-success-soft text-success'], doing: ['in corso', 'bg-info-soft text-info'], todo: ['da fare', 'bg-muted text-muted-foreground'], blocked: ['bloccato', 'bg-destructive-soft text-destructive'],
};

function signedOut(response: Response): boolean {
  if (response.status !== 401 || response.headers.get('x-everflow-login') !== 'required') return false;
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  return true;
}

function Section(props: { id: string; n: number; title: string; wide?: boolean; full?: boolean; children: React.ReactNode }) {
  return <section id={props.id} aria-labelledby={`${props.id}-h`} className={cn('scroll-mt-6 py-8 first:pt-2', props.full && 'relative z-30 bg-background lg:-ml-[15.5rem]')}>
    <h2 id={`${props.id}-h`} className="mb-4 flex items-baseline gap-3 text-2xl font-semibold tracking-tight">
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center self-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{props.n}</span>{props.title}
    </h2>
    <div className={cn('space-y-4 text-[17px] leading-relaxed', !props.wide && 'max-w-[920px]')}>{props.children}</div>
  </section>;
}

function Prose({ text, sources, ids }: { text: string; sources: Explainer['sources']; ids?: string[] }) {
  return <p><Glossed text={text} />{ids && <GuideSources ids={ids} sources={sources} />}</p>;
}

function Stat(props: { icon: React.ReactNode; value: number | string; label: string }) {
  return <div className="rounded-xl border bg-card p-4">
    <div className="flex items-center gap-2 text-muted-foreground">{props.icon}<span className="text-3xl font-semibold text-foreground tabular-nums">{props.value}</span></div>
    <p className="mt-1 text-sm text-muted-foreground">{props.label}</p>
  </div>;
}

function PersonPanel(props: { person: ExplainerPerson; explainer: Explainer; today: string; onClose: () => void; onShow: () => void }) {
  const { person, explainer } = props;
  const nodes = new Map(explainer.graph.nodes.map((node) => [node.id, node]));
  const owed = explainer.graph.edges.filter((edge) => edge.from === person.id && edge.kind === 'owes' && edge.src.some((id) => !!explainer.sources[id])).map((edge) => nodes.get(edge.to)).filter((node) => !!node && node.status !== 'done');
  return <aside aria-label={`Scheda di ${person.name}`} className="rounded-xl border bg-card p-4 text-[15px] leading-snug shadow-sm">
    <div className="flex items-start gap-2">
      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{initials(person.name)}</span>
      <div className="min-w-0"><h3 className="text-base font-semibold">{person.name}</h3><p className="text-sm text-muted-foreground"><Glossed text={person.role} /></p></div>
      <button type="button" aria-label="Chiudi la scheda" onClick={props.onClose} className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted"><X aria-hidden="true" className="size-4" /></button>
    </div>
    <p className="mt-3"><Glossed text={person.plain} /><GuideSources ids={person.src} sources={explainer.sources} /></p>
    <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[7rem_1fr]">
      <dt className="text-muted-foreground">Chiedigli</dt><dd><Glossed text={person.ask_for} /></dd>
      <dt className="text-muted-foreground">Come</dt><dd>{person.how}</dd>
    </dl>
    {!!owed.length && <div className="mt-3">
      <h4 className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Cose aperte che ti deve</h4>
      <ul className="list-disc space-y-1 pl-5 text-sm">{owed.map((node) => <li key={node!.id}>{node!.label}{node!.since ? <span className="text-muted-foreground"> · da {workDays(node!.since, props.today)} gg</span> : null}</li>)}</ul>
    </div>}
    <Button type="button" size="sm" className="mt-4" onClick={props.onShow}>Mostra cosa aspetto da lui</Button>
  </aside>;
}

const icons: Record<ExplainerIcon, typeof Vault> = {
  vault: Vault, 'key-round': KeyRound, lock: Lock, shield: Shield, 'shield-alert': ShieldAlert, fingerprint: Fingerprint, users: Users, user: User, bot: Bot,
  server: Server, database: Database, cloud: Cloud, container: Container, network: Network, 'git-branch': GitBranch, 'git-pull-request': GitPullRequest,
  ticket: Ticket, 'file-text': FileText, 'book-open': BookOpen, bell: Bell, siren: Siren, 'scroll-text': ScrollText, 'clipboard-check': ClipboardCheck,
  'list-checks': ListChecks, terminal: Terminal, monitor: Monitor, workflow: Workflow, 'refresh-cw': RefreshCw, eye: Eye, 'building-2': Building2,
};

function GlossaryEntry({ term }: { term: Explainer['glossary'][number] }) {
  const gloss = useGloss();
  const on = gloss?.highlight === term.id;
  const Icon = term.icon ? icons[term.icon] : null;
  return <div id={`g-${term.id}`} data-highlight={on ? 'true' : undefined}
    className={cn('scroll-mt-24 rounded-xl border bg-card p-4 transition-shadow duration-500', on && 'ring-2 ring-primary')}>
    <div className="min-w-0 text-[15px] leading-snug">
      <h3 className="text-base font-semibold">{Icon && <Icon aria-hidden="true" className="mr-2 inline size-4 text-primary" />}{term.term}{term.aliases.length > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">{term.aliases.join(', ')}</span>}</h3>
      <p className="mt-1 font-medium">{term.short}</p>
      {term.long && <p className="mt-1.5 text-muted-foreground"><Glossed text={term.long} skip={term.id} /></p>}
      {term.diagram && <Diagram diagram={term.diagram} className="mt-3" />}
      {on && <GlossBack />}
    </div>
  </div>;
}

function Body(props: { explainer: Explainer; state: GuideState; indexVisible: boolean; pending: string[]; onStep: (text: string, hide: boolean) => void }) {
  const { explainer: ex, state } = props;
  const [person, setPerson] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const people = useMemo(() => new Map(ex.people.map((item) => [item.id, item])), [ex]);
  const nameOf = (id: string | null | undefined) => !id ? '' : id === 'you' ? 'Tu' : people.get(id)?.name ?? id;
  const waiting = ex.graph.nodes.filter((node) => !!node.owner && node.owner !== 'you' && node.status !== 'done').length;
  const mine = ex.graph.nodes.filter((node) => node.owner === 'you' && node.status !== 'done').length;
  const latest = Object.values(ex.sources).map((source) => source.date).filter((date): date is string => !!date).sort().at(-1);
  const quiet = latest ? Math.max(0, Math.round((Date.parse(`${state.today}T00:00:00Z`) - Date.parse(`${latest.slice(0, 10)}T00:00:00Z`)) / 86_400_000)) : 'n.d.';
  const glossary = useMemo(() => [...ex.glossary].sort((a, b) => a.term.localeCompare(b.term, 'it')), [ex]);
  const summary = state.initiative.summary;
  const selected = person ? people.get(person) : undefined;
  const showGraph = (id: string) => { setFocus(id); document.getElementById('blocchi')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); };
  const { sources } = ex;
  const hidden = ex.next_you.filter((item) => (state.dismissed ?? []).includes(guideItemKey(item.text)));
  const visible = ex.next_you.filter((item) => !(state.dismissed ?? []).includes(guideItemKey(item.text)));
  return <>
    <Section id="breve" n={1} title="In breve" wide>
      <div className="max-w-[920px] space-y-4">
        <h1 className="text-3xl leading-tight font-semibold tracking-tight">{ex.title}</h1>
        <p className="rounded-xl bg-primary px-5 py-4 text-lg leading-snug font-medium text-primary-foreground [&_.gloss-term]:border-primary-foreground"><Glossed text={ex.one_liner} /></p>
        {summary && <div className="flex flex-wrap items-center gap-2.5"><StatePill view={state.initiative} /><span className="text-[15px]"><Inline text={summary.headline} /></span></div>}
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-3">
        <Stat icon={<Hourglass aria-hidden="true" className="size-5" />} value={waiting} label="Cose che aspetti dagli altri" />
        <Stat icon={<User aria-hidden="true" className="size-5" />} value={mine} label="Cose tue" />
        <Stat icon={<Clock aria-hidden="true" className="size-5" />} value={quiet} label="Giorni dall'ultima novità" />
      </div>
    </Section>
    <Section id="perche" n={2} title="Perché esiste">{ex.why.map((text, index) => <Prose key={index} text={text} sources={sources} />)}</Section>
    <Section id="ruolo" n={3} title="Il tuo ruolo"><Prose text={ex.role} sources={sources} /></Section>
    <Section id="chi" n={4} title="Chi c'è" wide>
      <div className="grid items-start gap-3 md:grid-cols-2">
        {ex.teams.map((team) => <div key={team.id} data-team={team.kind} className={cn('rounded-xl border p-3.5', teamTone[team.kind])}>
          <h3 className="text-base font-semibold">{team.name}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground"><Glossed text={team.plain} /></p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">{team.people.map((id) => people.get(id)).filter((item) => !!item).map((item) =>
            <button key={item!.id} type="button" data-person-chip={item!.id} aria-pressed={person === item!.id} onClick={() => setPerson(person === item!.id ? null : item!.id)}
              className="rounded-full border bg-card px-2.5 py-1 text-sm font-medium shadow-xs hover:bg-accent aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-primary">{item!.name}</button>)}</div>
        </div>)}
      </div>
      {selected && <div className="max-w-[920px]"><PersonPanel person={selected} explainer={ex} today={state.today} onClose={() => setPerson(null)} onShow={() => showGraph(selected.id)} /></div>}
    </Section>
    <Section id="concetti" n={5} title="I concetti" wide>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {ex.concepts.map((concept) => <article key={concept.id} aria-label={concept.title} className="flex flex-col gap-3 rounded-xl border bg-card p-5">
          <h3 className="text-xl font-semibold">{concept.title}</h3>
          <Prose text={concept.plain} sources={sources} ids={concept.src} />
          {concept.analogy && <p className="rounded-lg bg-muted/60 px-3.5 py-2.5 text-[15px]"><b>Analogia. </b><Glossed text={concept.analogy} /></p>}
          {concept.diagram && <Diagram diagram={concept.diagram} />}
          {concept.say && <p className="text-[15px] text-muted-foreground">In una frase: <q className="italic">{concept.say}</q></p>}
        </article>)}
      </div>
    </Section>
    <Section id="punto" n={6} title="A che punto siamo" wide>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {ex.phases.map((phase) => {
          const done = phase.items.filter((item) => item.status === 'done').length, pct = phase.items.length ? Math.round(done * 100 / phase.items.length) : 0;
          return <article key={phase.id} aria-label={phase.title} className="rounded-xl border bg-card p-5">
            <h3 className="text-lg font-semibold">{phase.title}</h3>
            <p className="mt-0.5 text-[15px] text-muted-foreground"><Glossed text={phase.plain} /></p>
            <div className="mt-3 flex items-center gap-2.5 text-xs text-muted-foreground">
              <div role="progressbar" aria-label={`Avanzamento ${phase.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-success" style={{ width: `${pct}%` }} /></div>
              <span className="tabular-nums">{done}/{phase.items.length}</span>
            </div>
            <ul className="mt-3 space-y-2.5">{phase.items.map((item, index) => <li key={index} className="flex gap-2.5 text-[15px] leading-snug">
              <span data-status={item.status} className={cn('mt-0.5 h-fit shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', itemTone[item.status][1])}>{itemTone[item.status][0]}</span>
              <span className="min-w-0"><span className="font-medium">{item.title}</span>{item.note && <span className="block text-sm text-muted-foreground"><Glossed text={item.note} /></span>}<GuideSources ids={item.src} sources={sources} /></span>
            </li>)}</ul>
          </article>;
        })}
      </div>
    </Section>
    <Section id="blocchi" n={7} title="Cosa blocca e sblocca" wide full={props.indexVisible}>
      <p className="max-w-[920px]">Tocca una persona o un riquadro per vedere le dipendenze documentate e, se presente, la catena verso il traguardo: <b>{ex.goal.label}</b>. <Glossed text={ex.goal.plain} /></p>
      <DependencyGraph explainer={ex} today={state.today} focus={focus} onFocusChange={setFocus} />
      {!!ex.blocked_by.length && <div className="grid items-start gap-3 md:grid-cols-2">
        {ex.blocked_by.map((item, index) => {
          const days = item.since ? workDays(item.since, state.today) : null;
          return <article key={index} aria-label={item.title} className="rounded-xl border border-destructive/30 bg-destructive-soft p-4 text-[15px] leading-snug">
            <h3 className="font-semibold">{item.title}</h3>
            <p className="mt-1.5"><Glossed text={item.plain} /><GuideSources ids={item.src} sources={sources} /></p>
            <p className="mt-2 text-sm text-muted-foreground">Da chi: <b className="text-foreground">{nameOf(item.who)}</b>{days !== null && <> · da {days} {days === 1 ? 'giorno lavorativo' : 'giorni lavorativi'}</>}</p>
          </article>;
        })}
      </div>}
      {!!ex.next_you.length && <div className="max-w-[920px] rounded-xl border bg-card p-4">
        <h3 className="mb-2 text-base font-semibold">I tuoi prossimi passi</h3>
        <ol className="list-decimal space-y-2 pl-5 text-[15px] leading-snug">{visible.map((item) => <li key={guideItemKey(item.text)}><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><b className="font-medium"><Glossed text={item.text} /></b><span className="block text-muted-foreground"><Glossed text={item.why} /><GuideSources ids={item.src} sources={sources} /></span></div><button type="button" aria-label="Nascondi questo passo" disabled={props.pending.includes(guideItemKey(item.text))} onClick={() => props.onStep(item.text, true)} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"><X aria-hidden="true" className="size-4" /></button></div></li>)}</ol>
        {hidden.length > 0 && <div className="mt-3 text-sm"><button type="button" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)} className="font-medium text-primary hover:underline">{showHidden ? 'Nascondi elenco' : `Mostra nascosti (${hidden.length})`}</button>
          {showHidden && <ul className="mt-2 space-y-2">{hidden.map((item) => <li key={guideItemKey(item.text)} className="flex items-start gap-2"><span className="min-w-0 flex-1">{item.text}</span><button type="button" disabled={props.pending.includes(guideItemKey(item.text))} onClick={() => props.onStep(item.text, false)} className="shrink-0 text-primary hover:underline">Ripristina</button></li>)}</ul>}</div>}
      </div>}
    </Section>
    <Section id="storia" n={8} title="La storia">
      <ol className="relative space-y-5 border-l-2 border-border pl-6">{ex.timeline.map((item, index) => <li key={index} className="relative">
        <span aria-hidden="true" className="absolute top-1.5 -left-[1.9rem] size-3 rounded-full border-2 border-primary bg-background" />
        <time dateTime={item.date} className="text-xs text-muted-foreground">{formatDate(item.date, true)}</time>
        <h3 className="text-base font-semibold">{item.title}</h3>
        <Prose text={item.plain} sources={sources} ids={item.src} />
      </li>)}</ol>
    </Section>
    <Section id="chiedere" n={9} title="A chi chiedere cosa" wide>
      <div className="overflow-x-auto rounded-xl border bg-card"><table className="w-full text-left text-[15px]">
        <thead className="bg-muted text-xs tracking-wide text-muted-foreground uppercase"><tr><th className="px-3.5 py-2.5">Se ti serve</th><th className="px-3.5 py-2.5">Chiedi a</th><th className="px-3.5 py-2.5">Come</th></tr></thead>
        <tbody className="divide-y">{ex.ask_who.map((row, index) => <tr key={index} className="align-top"><td className="px-3.5 py-2.5"><Glossed text={row.need} /></td><td className="px-3.5 py-2.5 font-medium whitespace-nowrap">{nameOf(row.who)}</td><td className="px-3.5 py-2.5 text-muted-foreground">{row.how}</td></tr>)}</tbody>
      </table></div>
    </Section>
    <Section id="attenzione" n={10} title="Attenzione">
      {ex.warnings.map((warning, index) => <div key={index} role="note" className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-[15px] leading-snug">
        <b className="text-warning">{warning.title}</b><p className="mt-1"><Glossed text={warning.text} /><GuideSources ids={warning.src} sources={sources} /></p>
      </div>)}
      {!ex.warnings.length && <p className="text-muted-foreground">Niente da segnalare.</p>}
    </Section>
    <Section id="glossario" n={11} title="Glossario" wide>
      <div className="grid items-start gap-3 lg:grid-cols-2">{glossary.map((term) => <GlossaryEntry key={term.id} term={term} />)}</div>
    </Section>
  </>;
}

export function GuidePage(props: { id: string; initialState: GuideState; token: string; signOut?: boolean }) {
  const [state, setState] = useState(props.initialState);
  const [error, setError] = useState('');
  const [active, setActive] = useState<string>(sections[0][0]);
  const [asked, setAsked] = useState(false);
  const [indexVisible, setIndexVisible] = useState(true);
  const [pending, setPending] = useState<string[]>([]);
  const stepRevision = useRef(0);
  const stepsPending = useRef(0);
  useEffect(() => { try { setIndexVisible(localStorage.getItem('everflow.guide.index') !== 'hidden'); } catch {} }, []);
  const toggleIndex = () => setIndexVisible((current) => {
    try { localStorage.setItem('everflow.guide.index', current ? 'hidden' : 'shown'); } catch {}
    return !current;
  });
  const step = async (text: string, hide: boolean) => {
    const key = guideItemKey(text);
    stepRevision.current++;
    stepsPending.current++;
    setPending((current) => [...current, key]);
    setError('');
    setState((current) => ({ ...current, dismissed: hide ? [...new Set([...(current.dismissed ?? []), key])] : (current.dismissed ?? []).filter((item) => item !== key) }));
    try {
      const response = await fetch(`/api/guide/${encodeURIComponent(props.id)}/${hide ? 'dismiss' : 'restore'}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-everflow-token': props.token }, body: JSON.stringify({ text }) });
      if (!response.ok) { signedOut(response); throw new Error(`HTTP ${response.status}`); }
    } catch (failure) {
      setState((current) => ({ ...current, dismissed: hide ? (current.dismissed ?? []).filter((item) => item !== key) : [...new Set([...(current.dismissed ?? []), key])] }));
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { stepRevision.current++; stepsPending.current--; setPending((current) => current.filter((item) => item !== key)); }
  };
  const load = useCallback(async () => {
    const revision = stepRevision.current;
    try {
      const response = await fetch(`/api/guide/${encodeURIComponent(props.id)}`, { cache: 'no-store', credentials: 'same-origin' });
      if (signedOut(response)) return;
      if (response.ok) { const next = await response.json() as GuideState; if (!stepsPending.current && revision === stepRevision.current) { setState(next); setError(''); } }
      else setError(`Guida non disponibile (HTTP ${response.status})`);
    } catch { setError('Guida non raggiungibile, nuovo tentativo tra poco'); }
  }, [props.id]);
  const busy = state.requested || state.running || asked;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);
  const regenerate = async () => {
    setError('');
    setAsked(true);
    try {
      const response = await fetch(`/api/guide/${encodeURIComponent(props.id)}/regenerate`, { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-everflow-token': props.token }, body: '{}' });
      if (signedOut(response)) return;
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      setState((current) => ({ ...current, requested: true }));
      setAsked(false);
    } catch (failure) { setAsked(false); setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const ex = state.explainer;
  useEffect(() => {
    if (!ex || typeof IntersectionObserver === 'undefined') return;
    const seen = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) entry.isIntersecting ? seen.add(entry.target.id) : seen.delete(entry.target.id);
      const first = sections.find(([id]) => seen.has(id));
      if (first) setActive(first[0]);
    }, { rootMargin: '-10% 0px -70% 0px' });
    for (const [id] of sections) { const element = document.getElementById(id); if (element) observer.observe(element); }
    return () => observer.disconnect();
  }, [ex]);
  const view = state.initiative;
  const toc = (id: string) => { setActive(id); };
  const button = <Button type="button" variant={ex ? 'outline' : 'default'} size="sm" disabled={busy || !state.providers} onClick={() => { void regenerate(); }}>
    <RefreshCw aria-hidden="true" className={cn(busy && 'animate-spin')} />{busy ? 'In preparazione...' : ex ? 'Rigenera la guida' : 'Prepara la guida'}</Button>;
  return <div className="min-h-dvh">
    <header className="border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/apple-icon.png" alt="" aria-hidden="true" className="size-9 object-contain" />
          <div className="leading-tight"><p className="text-[15px] font-semibold tracking-tight">Everflow</p><p className="text-xs text-muted-foreground">Guida · {formatDate(state.today)}</p></div>
        </div>
        <nav aria-label="Pagine" className="flex gap-0.5 rounded-lg bg-muted p-0.5 text-sm">
          <a href="/" className="rounded-md px-3 py-1 text-muted-foreground hover:text-foreground">Board</a>
          <a href="/overview" aria-current="page" className="rounded-md bg-card px-3 py-1 font-medium shadow-xs">Overview</a>
        </nav>
        <a href="/overview" className="inline-flex items-center gap-1 text-sm text-primary hover:underline sm:ml-auto"><ArrowLeft aria-hidden="true" className="size-4" />Torna alla panoramica</a>
        {ex && <button type="button" aria-pressed={indexVisible} onClick={toggleIndex} className="hidden rounded-md border px-3 py-1 text-sm hover:bg-accent lg:block">{indexVisible ? 'Nascondi indice' : 'Mostra indice'}</button>}
        {props.signOut && <Button variant="ghost" size="sm" className="text-muted-foreground"
          onClick={() => { void fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then((r) => r.headers.get('x-everflow-logout') ?? '/login', () => '/login').then((to) => window.location.assign(to)); }}>
          <LogOut aria-hidden="true" />Esci</Button>}
      </div>
    </header>
    <div className={cn('mx-auto max-w-[1600px] px-4 sm:px-6', ex && indexVisible && 'lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10')}>
      {ex && <>
        <nav aria-label="Indice" className="sticky top-0 z-20 -mx-4 flex gap-1.5 overflow-x-auto border-b bg-background/95 px-4 py-2 backdrop-blur lg:hidden">
          {sections.map(([id, title]) => <a key={id} href={`#${id}`} onClick={() => toc(id)} aria-current={active === id ? 'location' : undefined}
            className="shrink-0 rounded-full border bg-card px-3 py-1 text-sm aria-[current=location]:border-primary aria-[current=location]:bg-primary aria-[current=location]:text-primary-foreground">{title}</a>)}
        </nav>
        {indexVisible && <nav aria-label="Indice della guida" className="sticky top-6 z-20 hidden h-fit self-start py-8 lg:block">
          <p className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{view.client} · {view.title}</p>
          <ol className="space-y-0.5 border-l">{sections.map(([id, title], index) => <li key={id}><a href={`#${id}`} onClick={() => toc(id)} aria-current={active === id ? 'location' : undefined}
            className="-ml-px block border-l-2 border-transparent py-1 pl-3 text-sm text-muted-foreground hover:text-foreground aria-[current=location]:border-primary aria-[current=location]:font-medium aria-[current=location]:text-foreground">{index + 1}. {title}</a></li>)}</ol>
        </nav>}
      </>}
      <main className={cn('min-w-0 pb-16', !ex && 'lg:col-span-2')}>
        {(error || state.error) && <Alert variant="destructive" className="mt-4 border-warning/40 bg-warning-soft text-warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{state.error ? `Ultima preparazione fallita${state.error_at ? ` alle ${formatTime(state.error_at)}` : ''}` : 'Problema di collegamento'}</AlertTitle>
          <AlertDescription>{error || state.error}{ex && state.at ? `. Qui sotto la guida del ${formatTime(state.at)}.` : ''}</AlertDescription>
        </Alert>}
        {!ex ? <section aria-label="Guida in preparazione" className="mx-auto max-w-2xl space-y-4 py-12">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">{view.client}</p>
          <h1 className="text-3xl font-semibold tracking-tight">{view.title}</h1>
          <StatePill view={view} />
          {view.summary && <p className="text-lg"><Inline text={view.summary.headline} /></p>}
          <div className="rounded-xl border bg-card p-5">
            <p className="font-medium">{busy ? 'La guida è in preparazione.' : 'La guida non è ancora stata preparata.'}</p>
            <p className="mt-1 text-sm text-muted-foreground">Viene scritta dalla nota del progetto e dalle note collegate. Questa pagina si aggiorna da sola appena è pronta.</p>
            <div className="mt-3">{!state.requested && !state.running && !asked && button}{busy && <span className="text-sm text-muted-foreground">In preparazione...</span>}</div>
          </div>
        </section> : <GlossProvider terms={ex.glossary}>
          <Body explainer={ex} state={state} indexVisible={indexVisible} pending={pending} onStep={(text, hide) => { void step(text, hide); }} />
          <footer className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4 text-xs text-muted-foreground">
            <span>Generata {state.at ? formatTime(state.at) : ''}</span><span>Modello {ex.model}</span>
            <span>{ex.notes.length + 1} note lette</span>{ex.rejected > 0 && <span>{ex.rejected} elementi scartati per mancanza di fonti</span>}
            <span className="sm:ml-auto">{button}</span>
          </footer>
        </GlossProvider>}
      </main>
    </div>
  </div>;
}
