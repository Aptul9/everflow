'use client';

import { BellOff, ChevronDown, ChevronUp, CirclePause, Clock, FilePlus, LoaderCircle, MessagesSquare, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ChatFile, Group, SkippedBatch, TicketCard as CardData, TriageBatch } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { Checkbox } from '../ui/checkbox.tsx';
import { ActionDialog } from './action-dialog.tsx';
import { ChatDialog } from './chat-dialog.tsx';
import type { DescribeFile, ListFiles, ReadFile } from './file-viewer.tsx';
import { Inline, Markdown } from './markdown.tsx';
import { age, Expand, Field, formatTime, MessageList, Section, TicketCard, Toggle, tones } from './ticket-card.tsx';
import type { Tone } from './ticket-card.tsx';
import type { useOverview } from './use-overview.ts';

const columnTone: Record<Group, Tone> = { needs_you: 'needs', working: 'working', waiting_them: 'waiting', failed: 'failed', done_today: 'done', skipped: 'skipped' };
// Cards a column shows before Show more
const PAGE = 8;
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
    className={cn('relative overflow-hidden rounded-lg border bg-card transition-colors hover:border-foreground/20', props.enabled && 'cursor-grab active:cursor-grabbing', props.selected && 'border-primary/40 bg-accent/40')}>
    <span data-stripe aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-1', tones.skipped.bar)} />
    <div className="space-y-2 p-3">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {props.enabled && <Checkbox checked={props.selected} onCheckedChange={(checked) => props.onSelect(checked === true)} aria-label={`Select batch #${batch.id}`} className="size-4.5" />}
        <Badge variant="secondary" className="px-1.5 text-[11px]">{outcomes[batch.outcome]}</Badge>
        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-muted-foreground"><Clock aria-hidden="true" className="size-3" />
          <time dateTime={batch.created_at} title={formatTime(batch.created_at)} className="tabular-nums">{age(props.now, batch.created_at)}</time></span>
      </div>
      <h4 title={batch.title ?? undefined} className="line-clamp-3 text-sm leading-snug font-semibold"><span className="sr-only">{`Batch #${batch.id}:`}</span>{' '}{batch.title ?? '(no title)'}</h4>
      <p className="truncate text-xs text-muted-foreground" title={`${batch.source} · ${batch.account}`}>{batch.source} · {batch.account}</p>
      {batch.reason && <dl><Field label="Why" expanded={false}><Inline text={batch.reason} /></Field></dl>}
      <Expand label={`Expand batch #${batch.id}`} title={batch.title ?? '(no title)'} meta={<>
        <Badge variant="secondary" className="px-1.5 text-[11px]">{outcomes[batch.outcome]}</Badge>
        <span>{batch.source} · {batch.account}</span>
        <span>Age: {age(props.now, batch.created_at)}</span>
      </>}>
        {batch.reason && <dl><Field label="Why" expanded><Markdown text={batch.reason} /></Field></dl>}
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
        onConfirm={(_value, minutes) => props.post(muteKey, `/api/batch/${batch.id}/mute`, { minutes: minutes ?? null })} />}
      <Button type="button" variant="outline" size="icon-sm" className="h-9 w-9 sm:h-8 sm:w-8" aria-label={`Clear batch #${batch.id}`} title="Clear from the board (messages are kept)"
        disabled={props.expired || props.pending.has(clearKey)} onClick={() => { void props.post(clearKey, `/api/batch/${batch.id}/clear`).catch(() => {}); }}><X aria-hidden="true" /></Button>
    </div>}
    <div className="border-t px-2 py-1">
      <Toggle expanded={messagesOpen} controls={messagesId} onClick={() => setMessagesOpen(!messagesOpen)} icon={<MessagesSquare aria-hidden="true" />}>Messages ({batch.messages.length})</Toggle>
    </div>
    {messagesOpen && <div className="px-2 pb-2"><MessageList id={messagesId} messages={batch.messages} /></div>}
  </div>;
}

function TriageCard(props: { batch: TriageBatch; now: number }) {
  const { batch } = props;
  const messagesId = useId();
  const [messagesOpen, setMessagesOpen] = useState(false);
  const parked = batch.job === 'parked';
  return <div data-triage-batch={batch.id} className="rounded-lg border border-dashed border-primary/35 bg-card/70 shadow-xs">
    <div className="space-y-1.5 p-3">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span role="status" className={cn('inline-flex min-w-0 items-center gap-1 font-medium', parked ? 'text-destructive' : batch.held ? 'text-muted-foreground' : 'text-primary')}>
          {parked ? <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" /> : batch.held ? <CirclePause aria-hidden="true" className="size-3.5 shrink-0" />
            : <LoaderCircle aria-hidden="true" className={cn('size-3.5 shrink-0', batch.job === 'running' && 'animate-spin')} />}
          {batch.job === 'running' ? `Triage running${batch.clients.length ? ` for ${batch.clients.join(', ')}` : ''}` : parked ? 'Triage failed, see Problems'
            : batch.held ? `Held: ${batch.account} paused` : 'Waiting for triage'}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-muted-foreground"><Clock aria-hidden="true" className="size-3" />
          <time dateTime={batch.created_at} title={formatTime(batch.created_at)} className="tabular-nums">{age(props.now, batch.created_at)}</time></span>
      </div>
      <h4 title={batch.title ?? undefined} className="line-clamp-3 text-sm leading-snug font-semibold"><span className="sr-only">{`Batch #${batch.id}:`}</span>{' '}{batch.title ?? '(no title)'}</h4>
      <p className="truncate text-xs text-muted-foreground" title={`${batch.source} · ${batch.account}`}>{batch.source} · {batch.account}</p>
    </div>
    <div className="border-t px-2 py-1">
      <Toggle expanded={messagesOpen} controls={messagesId} onClick={() => setMessagesOpen(!messagesOpen)} icon={<MessagesSquare aria-hidden="true" />}>Messages ({batch.messages.length})</Toggle>
    </div>
    {messagesOpen && <div className="px-2 pb-2"><MessageList id={messagesId} messages={batch.messages} /></div>}
  </div>;
}

export type Board = ReturnType<typeof useOverview>;
// One column: its group decides what a drop on it does; batches and triage cards only exist on the board.
// id tells apart columns of the same group (default: the group)
export interface ColumnSpec { group: Group; id?: string; label: string; cards: CardData[]; batches?: SkippedBatch[]; triaging?: TriageBatch[] }
const gridColumns: Record<number, string> = { 5: 'xl:grid-cols-5', 6: 'xl:grid-cols-6' };

// The board's columns with their cards, selection, drag and drop, bulk actions, keyboard and chat dialog.
// The board and every Overview initiative show their tickets through it, so a change here reaches both.
export function TicketColumns(props: { board: Board; columns: ColumnSpec[]; title: string; summary: (shown: number) => React.ReactNode; query?: string; id?: string }) {
  const { state, now, expired, pending, errors, post, request, refresh } = props.board;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  const tickets = props.columns.flatMap((column) => column.cards);
  const allBatches = props.columns.flatMap((column) => column.batches ?? []);
  // The chat dialog ([web] chat_origin) and a discussed ticket whose chat the daemon is still creating
  const [chat, setChat] = useState<{ id: number; title: string; session_id: string } | null>(null);
  const [awaiting, setAwaiting] = useState<number | null>(null);
  const openChat = useCallback((id: number) => post(`ticket:${id}:open-chat`, `/api/ticket/${id}/open-chat`, {}, true) as Promise<{ session_id: string; directory: string }>, [post]);
  const chatFiles = useCallback<ListFiles>(async (id, signal) => ((await (await request(`/api/ticket/${id}/chat-files`, {}, signal)).json()) as { files: ChatFile[] }).files, [request]);
  const chatFile = useCallback<ReadFile>((id, path, download, signal) => request(`/api/ticket/${id}/chat-file`, { path, download }, signal), [request]);
  const chatFileInfo = useCallback<DescribeFile>(async (id, path) => ((await (await request(`/api/ticket/${id}/chat-file-info`, { path })).json()) as { file: ChatFile }).file, [request]);
  const discussed = awaiting === null ? undefined : tickets.find((ticket) => ticket.id === awaiting);
  useEffect(() => {
    if (awaiting === null) return;
    if (discussed?.session_id) { setChat({ id: discussed.id, title: discussed.title, session_id: discussed.session_id }); setAwaiting(null); return; }
    const poll = setInterval(() => { void refresh(); }, 2_000);
    return () => clearInterval(poll);
  }, [awaiting, discussed?.id, discussed?.title, discussed?.session_id, refresh]);
  useEffect(() => {
    if (awaiting === null) return;
    const giveUp = setTimeout(() => setAwaiting(null), 120_000);
    return () => clearTimeout(giveUp);
  }, [awaiting]);
  const available = new Set(tickets.filter((ticket) => ticket.lifecycle === 'proposed' || ticket.lifecycle === 'active').map((ticket) => ticket.id));
  const chosen = [...selected].filter((id) => available.has(id));
  const [batchSelection, setBatchSelection] = useState<Set<number>>(new Set());
  const chosenBatches = [...batchSelection].filter((id) => allBatches.some((batch) => batch.id === id));
  // Dismissed and done tickets select for Clear, open ones for Dismiss
  const [clearSelection, setClearSelection] = useState<Set<number>>(new Set());
  const clearable = new Set(tickets.filter((ticket) => ticket.lifecycle === 'done' || ticket.lifecycle === 'dismissed').map((ticket) => ticket.id));
  const chosenClears = [...clearSelection].filter((id) => clearable.has(id));
  const toggle = (set: (update: (previous: Set<number>) => Set<number>) => void, id: number, checked: boolean) =>
    set((previous) => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next; });
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const accepts = (group: Group) => !!dragging && dropAction(group, dragging, state.chats_enabled) !== null;
  const drop = (group: Group) => {
    const action = dragging && dropAction(group, dragging, state.chats_enabled);
    setOver(null);
    setDragging(null);
    if (!dragging || !action) return;
    const card = dragging.kind === 'ticket' ? `article[data-ticket-id="${dragging.ticket.id}"]` : `[data-batch-id="${dragging.id}"]`;
    root.current?.querySelector<HTMLButtonElement>(`${card} [data-action="${action}"]`)?.click();
  };
  const needle = (props.query ?? '').trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
        || document.querySelector('[role="dialog"][data-state="open"]')) return;
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

  const columns = props.columns.map(({ group, id = group, label, ...spec }) => {
    const batches = (spec.batches ?? []).filter((batch) => matches([batch.title, batch.source, batch.account, batch.outcome, ...batch.messages.map((message) => message.text)].join(' ')));
    const cards = spec.cards.filter((ticket) => matches([ticket.title, ticket.client, ticket.session_title, ticket.summary, ticket.ask, ticket.proposal, ...ticket.refs.map((ref) => ref.key)].join(' ')));
    const triaging = (spec.triaging ?? []).filter((batch) => matches([batch.title, batch.source, batch.account, ...batch.messages.map((message) => message.text)].join(' ')));
    const total = (spec.batches?.length ?? 0) + (spec.triaging?.length ?? 0) + spec.cards.length;
    const shown = batches.length + triaging.length + cards.length;
    // Each column renders its first `limit` cards in order: batches, then triage cards, then tickets
    const limit = limits[id] ?? PAGE;
    const visible = { batches: batches.slice(0, limit), triaging: triaging.slice(0, Math.max(0, limit - batches.length)),
      cards: cards.slice(0, Math.max(0, limit - batches.length - triaging.length)) };
    return { group, id, label, batches, triaging, cards, total, shown, limit, visible, hidden: Math.max(0, shown - limit) };
  });

  return <div ref={root}>
    <main id={props.id} tabIndex={-1} className="space-y-3 outline-none">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-sm font-semibold">{props.title}</h2>
        <p className="text-xs text-muted-foreground">{props.summary(columns.reduce((sum, column) => sum + column.shown, 0))}</p>
        {state.tickets_enabled && <div className="ml-auto flex items-center gap-2">
          {chosenBatches.length + chosenClears.length > 0 && <Button type="button" variant="outline" size="sm" className="h-9 sm:h-8" disabled={expired} onClick={() => {
            const clear = (scope: 'batch' | 'ticket', ids: number[], set: typeof setBatchSelection) => void Promise.all(ids.map(async (id) => {
              try { await post(`${scope}:${id}:clear`, `/api/${scope}/${id}/clear`); return id; } catch { return null; }
            })).then((results) => set((previous) => new Set([...previous].filter((id) => !results.includes(id)))));
            clear('batch', chosenBatches, setBatchSelection);
            clear('ticket', chosenClears, setClearSelection);
          }}><X aria-hidden="true" />Clear selected ({chosenBatches.length + chosenClears.length})</Button>}
          <ActionDialog label={`Dismiss selected (${chosen.length})`} title={`Dismiss ${chosen.length} selected tickets`} confirm="Confirm dismiss" size="sm" className="h-9 sm:h-8" mute="optional"
            disabled={chosen.length === 0 || expired} onConfirm={async (reason, mute) => {
              const results = await Promise.all(chosen.map(async (id) => {
                try { await post(`ticket:${id}:dismiss`, `/api/ticket/${id}/dismiss`, mute === undefined ? { reason } : { reason, mute_minutes: mute }); return id; } catch { return null; }
              }));
              setSelected((previous) => new Set([...previous].filter((id) => !results.includes(id))));
            }} />
        </div>}
      </div>
      <nav aria-label={`${props.title} columns`} className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:-mx-6 sm:px-6 xl:hidden">
        {columns.map((column) => <a key={column.id} href={`#col-${column.id}`} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs">
          <span aria-hidden="true" className={cn('size-1.5 rounded-full', tones[columnTone[column.group]].dot)} />{column.label}<span className="font-semibold tabular-nums">{column.total}</span>
        </a>)}
      </nav>
      <div className={cn('relative -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:scroll-px-6 sm:px-6 xl:mx-0 xl:grid xl:overflow-visible xl:px-0 xl:pb-0', gridColumns[columns.length] ?? 'xl:grid-cols-6')}>
        {columns.map((column) => <section key={column.id} id={`col-${column.id}`} data-column={column.id} aria-label={`${column.label} (${column.total})`}
          onDragOver={(event) => { if (accepts(column.group)) { event.preventDefault(); if (over !== column.id) setOver(column.id); } }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null); }}
          onDrop={(event) => { event.preventDefault(); drop(column.group); }}
          className={cn('flex w-[84vw] max-w-[340px] shrink-0 scroll-mt-28 snap-start flex-col rounded-xl bg-muted/80 ring-1 ring-border/60 transition-shadow sm:w-[300px] xl:w-auto xl:max-w-none xl:min-w-0',
            accepts(column.group) && 'ring-2 ring-primary/30', over === column.id && 'bg-accent/70 ring-primary/70')}>
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <span aria-hidden="true" className={cn('size-2 rounded-full', tones[columnTone[column.group]].dot)} />
            <h3 className="text-[13px] font-semibold">{column.label}</h3>
            <span className="rounded-full bg-background px-1.5 text-[11px] font-semibold text-muted-foreground tabular-nums">{column.total}</span>
            {needle && column.shown !== column.total && <span className="ml-auto text-[11px] text-muted-foreground">{column.shown} shown</span>}
            {state.tickets_enabled && column.group === 'skipped' && column.shown > 0 && <Checkbox aria-label="Select all skipped" className={cn('size-4', !(needle && column.shown !== column.total) && 'ml-auto')}
              checked={column.batches.every((batch) => batchSelection.has(batch.id)) && column.cards.every((card) => clearSelection.has(card.id))}
              onCheckedChange={(checked) => {
                setBatchSelection(checked === true ? new Set(column.batches.map((batch) => batch.id)) : new Set());
                setClearSelection(checked === true ? new Set(column.cards.map((card) => card.id)) : new Set());
              }} />}
          </div>
          <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
            {column.visible.batches.map((batch) => <BatchCard key={batch.id} batch={batch} enabled={state.tickets_enabled} expired={expired} pending={pending} errors={errors} post={post}
              selected={batchSelection.has(batch.id)} onSelect={(checked) => setBatchSelection((previous) => { const next = new Set(previous); if (checked) next.add(batch.id); else next.delete(batch.id); return next; })}
              now={now} onDrag={(active) => setDragging(active ? { kind: 'batch', id: batch.id } : null)} />)}
            {column.visible.triaging.map((batch) => <TriageCard key={batch.id} batch={batch} now={now} />)}
            {column.visible.cards.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} enabled={state.tickets_enabled} chats={state.chats_enabled} chatProject={(ticket.client && state.chat_projects?.[ticket.client]) || state.chat_project} expired={expired} now={now}
              {...(state.chat_origin ? { chatOrigin: state.chat_origin, onDiscussed: () => setAwaiting(ticket.id),
                ...(ticket.session_id ? { onOpenChat: () => setChat({ id: ticket.id, title: ticket.title, session_id: ticket.session_id! }) } : {}) } : {})}
              selected={clearable.has(ticket.id) ? clearSelection.has(ticket.id) : selected.has(ticket.id)}
              onSelect={(checked) => toggle(clearable.has(ticket.id) ? setClearSelection : setSelected, ticket.id, checked)}
              onDrag={(active) => setDragging(active ? { kind: 'ticket', ticket } : null)}
              pending={pending} errors={errors} post={post} />)}
            {(column.hidden > 0 || column.limit > PAGE) && <div className="flex gap-1.5">
              {column.hidden > 0 && <Button type="button" variant="ghost" size="sm" className="h-8 min-w-0 flex-1 text-xs text-muted-foreground"
                aria-label={`Show ${Math.min(PAGE, column.hidden)} more in ${column.label}`}
                onClick={() => setLimits((previous) => ({ ...previous, [column.id]: column.limit + PAGE }))}>
                <ChevronDown aria-hidden="true" />Show more<span className="tabular-nums">({column.hidden})</span></Button>}
              {column.limit > PAGE && <Button type="button" variant="ghost" size="sm" className="h-8 min-w-0 flex-1 text-xs text-muted-foreground"
                aria-label={`Show less in ${column.label}`} onClick={() => setLimits((previous) => ({ ...previous, [column.id]: PAGE }))}>
                <ChevronUp aria-hidden="true" />Show less</Button>}
            </div>}
            {column.shown === 0 && <p className="rounded-lg border border-dashed border-foreground/10 px-3 py-6 text-center text-xs text-muted-foreground">
              {column.total === 0 ? `No tickets in ${column.label.toLocaleLowerCase()}.` : 'No matches.'}
            </p>}
          </div>
        </section>)}
      </div>
    </main>
    {state.chat_origin && <ChatDialog ticket={chat} origin={state.chat_origin} open={openChat} files={chatFiles} file={chatFile} describe={chatFileInfo} onClose={() => setChat(null)} />}
  </div>;
}
