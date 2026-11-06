'use client';

import { useEffect, useRef, useState } from 'react';
import { groups } from '../../lib/web-types.ts';
import type { Group, OverviewState } from '../../lib/web-types.ts';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.tsx';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { Card, CardContent, CardHeader } from '../ui/card.tsx';
import { Input } from '../ui/input.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx';
import { ActionDialog } from './action-dialog.tsx';
import { Messages, TicketCard } from './ticket-card.tsx';
import { useOverview } from './use-overview.ts';

export function TicketBoard(props: { initialState: OverviewState; initialEtag: string; token: string; initialNow?: number }) {
  const { state, now, unreachable, expired, pending, errors, notice, post } = useOverview(props.initialState, props.initialEtag, props.token, props.initialNow);
  const [tab, setTab] = useState<Group>('needs_you');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const tickets = Object.values(state.groups).flat();
  const available = new Set(tickets.filter((ticket) => ticket.lifecycle === 'proposed' || ticket.lifecycle === 'active').map((ticket) => ticket.id));
  const chosen = [...selected].filter((id) => available.has(id));
  const matches = (text: string) => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
        || document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (event.key === '/') { event.preventDefault(); search.current?.focus(); return; }
      const cards = [...(root.current?.querySelectorAll<HTMLElement>('[role="tabpanel"][data-state="active"] article[data-ticket-id]') ?? [])];
      if (!cards.length) return;
      const index = cards.findIndex((card) => card === document.activeElement || card.contains(document.activeElement));
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        cards[Math.min(cards.length - 1, Math.max(0, index < 0 ? 0 : index + (event.key === 'j' ? 1 : -1)))]?.focus();
      } else if (['s', 'c', 'd'].includes(event.key) && index >= 0) {
        const action = cards[index]!.querySelector<HTMLButtonElement>(`[data-shortcut="${event.key}"]`);
        if (action && !action.disabled) { event.preventDefault(); action.focus(); action.click(); }
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, []);

  return <div ref={root} className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
    <a href="#tickets" className="sr-only rounded-md bg-background p-3 text-primary focus:not-sr-only">Skip to tickets</a>
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-2xl font-semibold tracking-tight">Inbox dispatcher</h1><p className="mt-1 text-sm text-muted-foreground">Local overview · {state.day}</p></div>
      <div className="w-full sm:w-80"><label htmlFor="ticket-search" className="mb-1 block text-sm font-medium">Search tickets</label><Input ref={search} id="ticket-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, client, reference, session title" /></div>
    </header>

    {expired && <Alert variant="destructive"><AlertTitle>Reload required</AlertTitle><AlertDescription><p>Server restarted or action token rejected. Reload page before submitting again.</p><Button type="button" variant="outline" onClick={() => window.location.reload()}>Reload page</Button></AlertDescription></Alert>}
    {unreachable && <Alert variant="destructive"><AlertTitle>Unreachable since {unreachable}</AlertTitle><AlertDescription>Showing last good state. Retrying every 10 seconds.</AlertDescription></Alert>}
    {!state.tickets_enabled && <Alert><AlertTitle>Tickets disabled</AlertTitle><AlertDescription>Read-only state and health. Work controls are unavailable.</AlertDescription></Alert>}
    {!state.chats_enabled && <Badge variant="secondary">Chats off</Badge>}

    <section aria-label="Health" className="rounded-lg border bg-card p-3">
      <h2 className="mb-2 text-sm font-semibold">Health</h2>
      <ul className="flex flex-wrap gap-x-5 gap-y-3">
        {state.health.map((health) => <li key={health.dependency} className="min-w-0 text-sm">
          <p><span className="font-medium">{health.dependency === 'opencode' ? 'OpenChamber' : health.dependency}</span>: {health.state}</p>
          {health.last_error && <p className="text-destructive">{health.last_error}</p>}
          {health.since && health.state !== 'ok' && <p className="text-xs text-muted-foreground">Since <time dateTime={health.since}>{health.since}</time></p>}
          {health.checkpoint && <p className="text-xs text-muted-foreground">Checkpoint: {health.checkpoint}</p>}
        </li>)}
      </ul>
    </section>

    <section aria-label="Problems">
      <Card className="gap-3 py-3 shadow-none">
        <CardHeader className="px-4"><h2 className="text-sm font-semibold">Problems ({state.problems.jobs.length + state.problems.quarantine.length + state.problems.triage.length})</h2></CardHeader>
        <CardContent className="space-y-3 px-4 text-sm">
          {state.problems.jobs.map((job) => <div key={job.id} className="rounded-md bg-muted p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{job.ticket === null ? 'Unbound job' : 'Job'} #{job.id} · {job.kind}{job.ticket === null ? '' : ` · Ticket #${job.ticket}`}</p>
              {state.tickets_enabled && <Button variant="outline" type="button" disabled={expired || pending.has(`job:${job.id}:retry`)} onClick={() => { void post(`job:${job.id}:retry`, `/api/job/${job.id}/retry`).catch(() => {}); }}>Retry job #{job.id}</Button>}
            </div>
            {job.last_error && <p>{job.last_error}</p>}{job.parse_error && <p>{job.parse_error}</p>}{job.raw && <pre className="mt-1 whitespace-pre-wrap">{job.raw}</pre>}
            {errors[`job:${job.id}:retry`] && <p role="alert" className="text-destructive">{errors[`job:${job.id}:retry`]}</p>}
          </div>)}
          {state.problems.quarantine.map((item) => <details key={item.id} className="rounded-md bg-muted p-3"><summary>Quarantine #{item.id} · {item.source}: {item.error}</summary><pre className="mt-2 whitespace-pre-wrap">{item.line}</pre>{item.truncated && <p>Input truncated.</p>}</details>)}
          {state.problems.triage.map((item) => <details key={item.id} className="rounded-md bg-muted p-3"><summary>Triage failure #{item.id}{item.batch === null ? '' : ` · Batch #${item.batch}`}: {item.parse_error}</summary><pre className="mt-2 whitespace-pre-wrap">{item.raw}</pre></details>)}
          {!state.problems.jobs.length && !state.problems.quarantine.length && !state.problems.triage.length && <p className="text-muted-foreground">No recorded problems.</p>}
        </CardContent>
      </Card>
    </section>

    <main id="tickets" tabIndex={-1}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Tickets</h2>
        {state.tickets_enabled && <ActionDialog label={`Dismiss selected (${chosen.length})`} title={`Dismiss ${chosen.length} selected tickets`} confirm="Confirm dismiss"
          disabled={chosen.length === 0 || expired} onConfirm={async (reason) => {
            const results = await Promise.all(chosen.map(async (id) => {
              try { await post(`ticket:${id}:dismiss`, `/api/ticket/${id}/dismiss`, { reason }); return id; } catch { return null; }
            }));
            setSelected((previous) => new Set([...previous].filter((id) => !results.includes(id))));
          }} />}
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(value as Group)}>
        <TabsList aria-label="Ticket groups" className="mb-2 h-auto! w-full flex-wrap justify-start gap-1 bg-muted p-1">
          {groups.map(([group, label]) => <TabsTrigger key={group} value={group} className="min-h-10 flex-none px-3 text-muted-foreground" aria-label={`${label} (${group === 'skipped' ? state.skipped.length : state.groups[group].length})`}>
            {label} <span className="tabular-nums">({group === 'skipped' ? state.skipped.length : state.groups[group].length})</span>
          </TabsTrigger>)}
        </TabsList>
        {groups.map(([group, label]) => <TabsContent key={group} value={group} className="space-y-3">
          {group === 'skipped' ? state.skipped.filter((batch) => matches([batch.title, batch.source, batch.account, batch.outcome, ...batch.messages.map((message) => message.text)].join(' '))).map((batch) => <Card key={batch.id} className="gap-3 py-4 shadow-none">
            <CardHeader className="px-4"><h3 className="font-semibold">Batch #{batch.id}: {batch.title ?? '(no title)'}</h3><p className="text-sm text-muted-foreground">{batch.source} · {batch.account} · {batch.outcome}</p></CardHeader>
            <CardContent className="space-y-2 px-4"><Messages messages={batch.messages} />
              {state.tickets_enabled && <Button type="button" variant="outline" aria-label={`Make ticket from batch #${batch.id}`} disabled={expired || pending.has(`batch:${batch.id}:ticket`)} onClick={() => { void post(`batch:${batch.id}:ticket`, `/api/batch/${batch.id}/ticket`).catch(() => {}); }}>Make ticket</Button>}
              {errors[`batch:${batch.id}:ticket`] && <p role="alert" className="text-sm text-destructive">{errors[`batch:${batch.id}:ticket`]}</p>}
            </CardContent>
          </Card>) : state.groups[group].filter((ticket) => matches([ticket.title, ticket.client, ticket.session_title, ticket.summary, ticket.ask, ticket.proposal, ...ticket.refs.map((ref) => ref.key)].join(' '))).map((ticket) =>
            <TicketCard key={ticket.id} ticket={ticket} enabled={state.tickets_enabled} chats={state.chats_enabled} expired={expired} now={now}
              selected={selected.has(ticket.id)} onSelect={(checked) => setSelected((previous) => { const next = new Set(previous); if (checked) next.add(ticket.id); else next.delete(ticket.id); return next; })}
              pending={pending} errors={errors} post={post} />)}
          {(group === 'skipped' ? state.skipped.length === 0 : state.groups[group].length === 0) && <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No tickets in {label.toLocaleLowerCase()}.</p>}
        </TabsContent>)}
      </Tabs>
    </main>
    <footer className="space-y-1 text-sm text-muted-foreground"><p>Dismissed: {state.feedback.dismiss_count}. Made tickets: {state.feedback.make_ticket_count}.</p><p>Keyboard: j/k cards, s Start, c note, d Dismiss, / search.</p><p role="status" aria-live="polite">{notice}</p></footer>
  </div>;
}
