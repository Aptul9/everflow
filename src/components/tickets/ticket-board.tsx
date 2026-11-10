'use client';

import { Bell, BellOff, Clock, FilePlus, Inbox, Keyboard, MessagesSquare, RefreshCw, Search, TriangleAlert, WifiOff, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { groups } from '../../lib/web-types.ts';
import type { Group, OverviewState, SkippedBatch, TicketCard as CardData } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.tsx';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { Checkbox } from '../ui/checkbox.tsx';
import { Input } from '../ui/input.tsx';
import { ActionDialog, Kbd } from './action-dialog.tsx';
import { Pipeline, Problems } from './pipeline.tsx';
import { age, Expand, Field, formatTime, MessageList, Section, TicketCard, Time, Toggle, tones } from './ticket-card.tsx';
import type { Tone } from './ticket-card.tsx';
import { useOverview } from './use-overview.ts';

const columnTone: Record<Group, Tone> = { needs_you: 'needs', working: 'working', waiting_them: 'waiting', failed: 'failed', done_today: 'done', skipped: 'skipped' };
const outcomes: Record<SkippedBatch['outcome'], string> = { not_on_us: 'Not on us', backlog: 'Backlog', answered: 'Answered', muted: 'Muted' };
type Post = (key: string, path: string, input?: Record<string, string | number | null>) => Promise<unknown>;

type Dragged = { kind: 'ticket'; ticket: CardData } | { kind: 'batch'; id: number };

// What dropping a card on a column does; null where a drop means nothing
function dropAction(group: Group, dragged: Dragged, chats: boolean): 'start' | 'done' | 'dismiss' | 'make' | null {
  if (dragged.kind === 'batch') return group === 'needs_you' ? 'make' : null;
  const { ticket } = dragged;
  if (ticket.lifecycle !== 'proposed' && ticket.lifecycle !== 'active') return null;
  if (group === 'working') return ticket.lifecycle === 'proposed' && chats ? 'start' : null;
  return group === 'done_today' ? 'done' : group === 'skipped' ? 'dismiss' : null;
}

function BatchCard(props: { batch: SkippedBatch; enabled: boolean; expired: boolean; pending: ReadonlySet<string>; errors: Record<string, string>; post: Post;
  selected: boolean; onSelect: (checked: boolean) => void; now: number; onDrag: (dragging: boolean) => void }) {
  const { batch } = props;
  const key = `batch:${batch.id}:ticket`;
  const muteKey = `batch:${batch.id}:mute`;
  const clearKey = `batch:${batch.id}:clear`;
  const messagesId = useId();
  const fullMessagesId = useId();
  const [messagesOpen, setMessagesOpen] = useState(false);
  const error = props.errors[key] || props.errors[muteKey] || props.errors[clearKey];
  return <div data-batch-id={batch.id} draggable={props.enabled}
    onDragStart={(event) => { event.dataTransfer?.setData('text/plain', `batch #${batch.id}`); props.onDrag(true); }} onDragEnd={() => props.onDrag(false)}
    className={cn('rounded-lg border bg-card shadow-xs', props.enabled && 'cursor-grab active:cursor-grabbing', props.selected && 'border-primary/40 bg-accent/40')}>
    <div className="space-y-2 p-3">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {props.enabled && <Checkbox checked={props.selected} onCheckedChange={(checked) => props.onSelect(checked === true)} aria-label={`Select batch #${batch.id}`} className="size-4.5" />}
        <Badge variant="secondary" className="px-1.5 text-[11px]">{outcomes[batch.outcome]}</Badge>
        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-muted-foreground"><Clock aria-hidden="true" className="size-3" />
          <time dateTime={batch.created_at} title={formatTime(batch.created_at)} className="tabular-nums">{age(props.now, batch.created_at)}</time></span>
      </div>
      <h4 className="text-sm leading-snug font-semibold"><span className="sr-only">{`Batch #${batch.id}:`}</span>{' '}{batch.title ?? '(no title)'}</h4>
      <p className="truncate text-xs text-muted-foreground" title={`${batch.source} · ${batch.account}`}>{batch.source} · {batch.account}</p>
      {batch.reason && <dl><Field label="Why" expanded={false}>{batch.reason}</Field></dl>}
      <Expand label={`Expand batch #${batch.id}`} title={batch.title ?? '(no title)'} meta={<>
        <Badge variant="secondary" className="px-1.5 text-[11px]">{outcomes[batch.outcome]}</Badge>
        <span>{batch.source} · {batch.account}</span>
        <span>Age: {age(props.now, batch.created_at)}</span>
      </>}>
        {batch.reason && <dl><Field label="Why" expanded>{batch.reason}</Field></dl>}
        <Section title={`Messages (${batch.messages.length})`}><MessageList id={fullMessagesId} messages={batch.messages} /></Section>
      </Expand>
      {error && <p role="alert" className="rounded-md bg-destructive-soft px-2.5 py-1.5 text-xs text-destructive">{error}</p>}
    </div>
    {props.enabled && <div className="@container flex items-center gap-1.5 border-t px-3 py-2">
      <Button type="button" variant="outline" size="sm" data-action="make" className="h-9 min-w-0 flex-1 sm:h-8" aria-label={`Make ticket from batch #${batch.id}`} title="Make ticket" disabled={props.expired || props.pending.has(key)}
        onClick={() => { void props.post(key, `/api/batch/${batch.id}/ticket`).catch(() => {}); }}><FilePlus aria-hidden="true" /><span className="hidden truncate @[13rem]:inline">Make ticket</span>
        <span aria-hidden="true" className="hidden @[10.5rem]:inline @[13rem]:hidden">Ticket</span></Button>
      {batch.outcome !== 'muted' && <ActionDialog label={`Mute chat of batch #${batch.id}`} display={null} title={`Mute ${batch.title ?? 'this chat'}`} confirm="Mute chat" mute="only" size="icon-sm"
        icon={<BellOff aria-hidden="true" />} className="h-9 w-9 sm:h-8 sm:w-8" disabled={props.expired || props.pending.has(muteKey)}
        onConfirm={(_value, hours) => props.post(muteKey, `/api/batch/${batch.id}/mute`, { hours: hours ?? null })} />}
      <Button type="button" variant="outline" size="icon-sm" className="h-9 w-9 sm:h-8 sm:w-8" aria-label={`Clear batch #${batch.id}`} title="Clear from the board (messages are kept)"
        disabled={props.expired || props.pending.has(clearKey)} onClick={() => { void props.post(clearKey, `/api/batch/${batch.id}/clear`).catch(() => {}); }}><X aria-hidden="true" /></Button>
    </div>}
    <div className="border-t px-2 py-1">
      <Toggle expanded={messagesOpen} controls={messagesId} onClick={() => setMessagesOpen(!messagesOpen)} icon={<MessagesSquare aria-hidden="true" />}>Messages ({batch.messages.length})</Toggle>
    </div>
    {messagesOpen && <div className="px-2 pb-2"><MessageList id={messagesId} messages={batch.messages} /></div>}
  </div>;
}

function MutedChats(props: { state: OverviewState; expired: boolean; pending: ReadonlySet<string>; errors: Record<string, string>; post: Post }) {
  if (!props.state.muted.length) return null;
  return <section aria-label={`Muted chats (${props.state.muted.length})`} className="rounded-lg border bg-card px-3 py-2.5 shadow-xs">
    <h2 className="flex items-center gap-2 text-sm font-semibold"><BellOff aria-hidden="true" className="size-4 text-muted-foreground" />Muted chats<span className="text-xs font-normal text-muted-foreground">{props.state.muted.length}</span></h2>
    <ul className="mt-1.5 divide-y divide-border/60">
      {props.state.muted.map((chat) => {
        const key = `conversation:${chat.id}:unmute`;
        return <li key={chat.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-xs">
          <span className="min-w-0 truncate font-medium">{chat.title ?? '(no title)'}</span>
          <span className="min-w-0 truncate text-muted-foreground">{chat.source} · {chat.account}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">{chat.forever ? 'until unmuted' : <>until <Time value={chat.until} /></>}</span>
          {props.state.tickets_enabled && <Button type="button" variant="outline" size="sm" className="h-8" aria-label={`Unmute ${chat.title ?? `chat ${chat.id}`}`}
            disabled={props.expired || props.pending.has(key)} onClick={() => { void props.post(key, `/api/conversation/${chat.id}/unmute`).catch(() => {}); }}>
            <Bell aria-hidden="true" />Unmute</Button>}
          {props.errors[key] && <p role="alert" className="w-full text-destructive">{props.errors[key]}</p>}
        </li>;
      })}
    </ul>
  </section>;
}

export function TicketBoard(props: { initialState: OverviewState; initialEtag: string; token: string; initialNow?: number }) {
  const { state, now, unreachable, expired, pending, errors, notice, post } = useOverview(props.initialState, props.initialEtag, props.token, props.initialNow);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const tickets = Object.values(state.groups).flat();
  const available = new Set(tickets.filter((ticket) => ticket.lifecycle === 'proposed' || ticket.lifecycle === 'active').map((ticket) => ticket.id));
  const chosen = [...selected].filter((id) => available.has(id));
  const [batchSelection, setBatchSelection] = useState<Set<number>>(new Set());
  const chosenBatches = [...batchSelection].filter((id) => state.skipped.some((batch) => batch.id === id));
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const [over, setOver] = useState<Group | null>(null);
  const accepts = (group: Group) => !!dragging && dropAction(group, dragging, state.chats_enabled) !== null;
  const drop = (group: Group) => {
    const action = dragging && dropAction(group, dragging, state.chats_enabled);
    setOver(null);
    setDragging(null);
    if (!dragging || !action) return;
    const card = dragging.kind === 'ticket' ? `article[data-ticket-id="${dragging.ticket.id}"]` : `[data-batch-id="${dragging.id}"]`;
    root.current?.querySelector<HTMLButtonElement>(`${card} [data-action="${action}"]`)?.click();
  };
  const needle = query.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
        || document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (event.key === '/') { event.preventDefault(); search.current?.focus(); return; }
      const cards = [...(root.current?.querySelectorAll<HTMLElement>('article[data-ticket-id]') ?? [])];
      if (!cards.length) return;
      const index = cards.findIndex((card) => card === document.activeElement || card.contains(document.activeElement));
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        cards[Math.min(cards.length - 1, Math.max(0, index < 0 ? 0 : index + (event.key === 'j' ? 1 : -1)))]?.focus();
      } else if (event.key === 'h' || event.key === 'l') {
        const columns = [...(root.current?.querySelectorAll<HTMLElement>('[data-column]') ?? [])].map((column) => [...column.querySelectorAll<HTMLElement>('article[data-ticket-id]')]);
        const current = index < 0 ? -1 : columns.findIndex((column) => column.includes(cards[index]!));
        const row = current < 0 ? 0 : columns[current]!.indexOf(cards[index]!);
        const step = event.key === 'l' ? 1 : -1;
        for (let next = current < 0 ? (step > 0 ? 0 : columns.length - 1) : current + step; next >= 0 && next < columns.length; next += step) {
          const column = columns[next]!;
          if (column.length) { event.preventDefault(); column[Math.min(row, column.length - 1)]!.focus(); break; }
        }
      } else if (['s', 'c', 'd', 'e'].includes(event.key) && index >= 0) {
        const action = cards[index]!.querySelector<HTMLButtonElement>(`[data-shortcut="${event.key}"]`);
        if (action && !action.disabled) { event.preventDefault(); action.focus(); action.click(); }
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, []);

  const columns = groups.map(([group, label]) => {
    const batches = group === 'skipped' ? state.skipped.filter((batch) => matches([batch.title, batch.source, batch.account, batch.outcome, ...batch.messages.map((message) => message.text)].join(' '))) : [];
    const cards = state.groups[group].filter((ticket) => matches([ticket.title, ticket.client, ticket.session_title, ticket.summary, ticket.ask, ticket.proposal, ...ticket.refs.map((ref) => ref.key)].join(' ')));
    const total = (group === 'skipped' ? state.skipped.length : 0) + state.groups[group].length;
    return { group, label, batches, cards, total, shown: batches.length + cards.length };
  });

  return <div ref={root} className="min-h-dvh">
    <a href="#tickets" className="sr-only rounded-md bg-background p-3 text-primary focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50">Skip to tickets</a>
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm"><Inbox className="size-4" /></span>
          <div className="leading-tight">
            <h1 className="text-[15px] font-semibold tracking-tight">Workdesk</h1>
            <p className="text-xs text-muted-foreground">Local overview · {state.day}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs', unreachable ? 'border-destructive/25 bg-destructive-soft text-destructive' : 'bg-card text-muted-foreground')}>
            {unreachable ? <WifiOff aria-hidden="true" className="size-3.5" /> : <span aria-hidden="true" className="size-2 rounded-full bg-success" />}
            {unreachable ? 'Offline' : 'Live'}
          </span>
          {!state.chats_enabled && <Badge variant="outline">Chats off</Badge>}
        </div>
        <div className="relative order-last w-full sm:order-none sm:ml-auto sm:w-80">
          <label htmlFor="ticket-search" className="sr-only">Search tickets</label>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={search} id="ticket-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, client, reference, session" className="h-10 bg-card pr-9 pl-8 sm:h-9" />
          {!query && <Kbd aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 sm:inline-flex">/</Kbd>}
        </div>
      </div>
    </header>

    <div className="mx-auto max-w-[1600px] space-y-4 px-4 py-4 sm:px-6 sm:py-5">
      {expired && <Alert variant="destructive" className="border-destructive/30 bg-destructive-soft">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Reload required</AlertTitle>
        <AlertDescription className="flex w-full flex-wrap items-center justify-between gap-3">
          <p>Server restarted or action token rejected. Reload page before submitting again.</p>
          <Button type="button" variant="outline" className="h-10 sm:h-9" onClick={() => window.location.reload()}><RefreshCw aria-hidden="true" />Reload page</Button>
        </AlertDescription>
      </Alert>}
      {unreachable && <Alert className="border-warning/30 bg-warning-soft text-warning">
        <WifiOff aria-hidden="true" />
        <AlertTitle>Unreachable since <span suppressHydrationWarning>{formatTime(unreachable)}</span></AlertTitle>
        <AlertDescription className="text-foreground/80">Showing last good state. Retrying every 10 seconds.</AlertDescription>
      </Alert>}
      {!state.tickets_enabled && <Alert>
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Tickets disabled</AlertTitle>
        <AlertDescription>Read-only state and health. Work controls are unavailable.</AlertDescription>
      </Alert>}

      <Pipeline state={state} />
      <Problems state={state} expired={expired} pending={pending} errors={errors} post={post} />
      <MutedChats state={state} expired={expired} pending={pending} errors={errors} post={post} />

      <main id="tickets" tabIndex={-1} className="space-y-3 outline-none">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="text-sm font-semibold">Board</h2>
          <p className="text-xs text-muted-foreground">{needle ? `${columns.reduce((sum, column) => sum + column.shown, 0)} matching "${query.trim()}"` : `${tickets.length} tickets today, ${state.skipped.length} skipped batches`}</p>
          {state.tickets_enabled && <div className="ml-auto flex items-center gap-2">
            {chosenBatches.length > 0 && <Button type="button" variant="outline" size="sm" className="h-9 sm:h-8" disabled={expired} onClick={() => {
              void Promise.all(chosenBatches.map(async (id) => {
                try { await post(`batch:${id}:clear`, `/api/batch/${id}/clear`); return id; } catch { return null; }
              })).then((results) => setBatchSelection((previous) => new Set([...previous].filter((id) => !results.includes(id)))));
            }}><X aria-hidden="true" />Clear selected ({chosenBatches.length})</Button>}
            <ActionDialog label={`Dismiss selected (${chosen.length})`} title={`Dismiss ${chosen.length} selected tickets`} confirm="Confirm dismiss" size="sm" className="h-9 sm:h-8" mute="optional"
              disabled={chosen.length === 0 || expired} onConfirm={async (reason, mute) => {
                const results = await Promise.all(chosen.map(async (id) => {
                  try { await post(`ticket:${id}:dismiss`, `/api/ticket/${id}/dismiss`, mute === undefined ? { reason } : { reason, mute_hours: mute }); return id; } catch { return null; }
                }));
                setSelected((previous) => new Set([...previous].filter((id) => !results.includes(id))));
              }} />
          </div>}
        </div>
        <nav aria-label="Board columns" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:-mx-6 sm:px-6 xl:hidden">
          {columns.map((column) => <a key={column.group} href={`#col-${column.group}`} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs">
            <span aria-hidden="true" className={cn('size-1.5 rounded-full', tones[columnTone[column.group]].dot)} />{column.label}<span className="font-semibold tabular-nums">{column.total}</span>
          </a>)}
        </nav>
        <div className="relative -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:scroll-px-6 sm:px-6 xl:mx-0 xl:grid xl:grid-cols-6 xl:overflow-visible xl:px-0 xl:pb-0">
          {columns.map((column) => <section key={column.group} id={`col-${column.group}`} data-column={column.group} aria-label={`${column.label} (${column.total})`}
            onDragOver={(event) => { if (accepts(column.group)) { event.preventDefault(); if (over !== column.group) setOver(column.group); } }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null); }}
            onDrop={(event) => { event.preventDefault(); drop(column.group); }}
            className={cn('flex w-[84vw] max-w-[340px] shrink-0 scroll-mt-28 snap-start flex-col rounded-xl bg-muted/80 ring-1 ring-border/60 transition-shadow sm:w-[300px] xl:w-auto xl:max-w-none',
              accepts(column.group) && 'ring-2 ring-primary/30', over === column.group && 'bg-accent/70 ring-primary/70')}>
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
              <span aria-hidden="true" className={cn('size-2 rounded-full', tones[columnTone[column.group]].dot)} />
              <h3 className="text-[13px] font-semibold">{column.label}</h3>
              <span className="rounded-full bg-background px-1.5 text-[11px] font-semibold text-muted-foreground tabular-nums">{column.total}</span>
              {needle && column.shown !== column.total && <span className="ml-auto text-[11px] text-muted-foreground">{column.shown} shown</span>}
              {state.tickets_enabled && column.batches.length > 0 && <Checkbox aria-label="Select all skipped" className={cn('size-4', !(needle && column.shown !== column.total) && 'ml-auto')}
                checked={column.batches.every((batch) => batchSelection.has(batch.id))}
                onCheckedChange={(checked) => setBatchSelection(checked === true ? new Set(column.batches.map((batch) => batch.id)) : new Set())} />}
            </div>
            <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
              {column.batches.map((batch) => <BatchCard key={batch.id} batch={batch} enabled={state.tickets_enabled} expired={expired} pending={pending} errors={errors} post={post}
                selected={batchSelection.has(batch.id)} onSelect={(checked) => setBatchSelection((previous) => { const next = new Set(previous); if (checked) next.add(batch.id); else next.delete(batch.id); return next; })}
                now={now} onDrag={(active) => setDragging(active ? { kind: 'batch', id: batch.id } : null)} />)}
              {column.cards.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} enabled={state.tickets_enabled} chats={state.chats_enabled} expired={expired} now={now}
                selected={selected.has(ticket.id)} onSelect={(checked) => setSelected((previous) => { const next = new Set(previous); if (checked) next.add(ticket.id); else next.delete(ticket.id); return next; })}
                onDrag={(active) => setDragging(active ? { kind: 'ticket', ticket } : null)}
                pending={pending} errors={errors} post={post} />)}
              {column.shown === 0 && <p className="rounded-lg border border-dashed border-foreground/10 px-3 py-6 text-center text-xs text-muted-foreground">
                {column.total === 0 ? `No tickets in ${column.label.toLocaleLowerCase()}.` : 'No matches.'}
              </p>}
            </div>
          </section>)}
        </div>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t pt-4 text-xs text-muted-foreground">
        <p>Dismissed: {state.feedback.dismiss_count}. Made tickets: {state.feedback.make_ticket_count}.</p>
        <p className="hidden flex-wrap items-center gap-x-3 gap-y-1 sm:flex">
          <Keyboard aria-hidden="true" className="size-4" />
          <span><Kbd>j</Kbd> <Kbd>k</Kbd> cards</span><span><Kbd>h</Kbd> <Kbd>l</Kbd> columns</span><span><Kbd>s</Kbd> Start</span><span><Kbd>c</Kbd> note</span><span><Kbd>d</Kbd> Dismiss</span><span><Kbd>e</Kbd> Expand</span><span><Kbd>/</Kbd> search</span><span><Kbd>Esc</Kbd> close</span>
        </p>
        <p role="status" aria-live="polite" className="w-full">{notice}</p>
      </footer>
    </div>
  </div>;
}
