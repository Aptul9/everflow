'use client';

import { Bell, BellOff, ExternalLink, Keyboard, LogOut, MessagesSquare, RefreshCw, Search, TriangleAlert, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { groups } from '../../lib/web-types.ts';
import type { OverviewState } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.tsx';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Kbd } from './action-dialog.tsx';
import { Pipeline, Problems } from './pipeline.tsx';
import { formatTime, Time } from './ticket-card.tsx';
import { TicketColumns } from './ticket-columns.tsx';
import { useAttention, useOverview } from './use-overview.ts';

type Post = (key: string, path: string, input?: Record<string, string | number | null>) => Promise<unknown>;
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

export function TicketBoard(props: { initialState: OverviewState; initialEtag: string; token: string; initialNow?: number; signOut?: boolean }) {
  const board = useOverview(props.initialState, props.initialEtag, props.token, props.initialNow);
  const { state, unreachable, expired, pending, errors, notice, post } = board;
  useAttention(state.groups.needs_you.length + state.groups.failed.length);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const tickets = Object.values(state.groups).flat();
  const needle = query.trim();

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.key !== '/' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
        || document.querySelector('[role="dialog"][data-state="open"]')) return;
      event.preventDefault();
      search.current?.focus();
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, []);

  const columns = groups.map(([group, label]) => ({ group, label, cards: state.groups[group],
    ...(group === 'skipped' ? { batches: state.skipped } : {}), ...(group === 'needs_you' ? { triaging: state.triaging } : {}) }));
  return <div className="min-h-dvh">
    <a href="#tickets" className="sr-only rounded-md bg-background p-3 text-primary focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50">Skip to tickets</a>
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/apple-icon.png" alt="" aria-hidden="true" className="size-9 object-contain" />
          <div className="leading-tight">
            <h1 className="text-[15px] font-semibold tracking-tight">Everflow</h1>
            <p className="text-xs text-muted-foreground">Local overview · {state.day}</p>
          </div>
        </div>
        <nav aria-label="Pages" className="flex gap-0.5 rounded-lg bg-muted p-0.5 text-sm">
          <a href="/" aria-current="page" className="rounded-md bg-card px-3 py-1 font-medium shadow-xs">Board</a>
          <a href="/overview" className="rounded-md px-3 py-1 text-muted-foreground hover:text-foreground">Overview</a>
        </nav>
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs', unreachable ? 'border-destructive/25 bg-destructive-soft text-destructive' : 'bg-card text-muted-foreground')}>
            {unreachable ? <WifiOff aria-hidden="true" className="size-3.5" /> : <span aria-hidden="true" className="size-2 rounded-full bg-success" />}
            {unreachable ? 'Offline' : 'Live'}
          </span>
          {!state.chats_enabled && <Badge variant="outline">Chats off</Badge>}
        </div>
        {state.chat_origin && <Button asChild variant="outline" size="sm" className="h-10 sm:ml-auto sm:h-9">
          <a href={state.chat_origin} target="_blank" rel="noopener"><MessagesSquare aria-hidden="true" />OpenChamber<ExternalLink aria-hidden="true" className="size-3 text-muted-foreground" /></a>
        </Button>}
        <div className={cn('relative order-last w-full sm:order-none sm:w-80', !state.chat_origin && 'sm:ml-auto')}>
          <label htmlFor="ticket-search" className="sr-only">Search tickets</label>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={search} id="ticket-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, client, reference, session" className="h-10 bg-card pr-9 pl-8 sm:h-9" />
          {!query && <Kbd aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 sm:inline-flex">/</Kbd>}
        </div>
        {props.signOut && <Button variant="ghost" size="sm" className="text-muted-foreground"
          onClick={() => { void fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then((r) => r.headers.get('x-everflow-logout') ?? '/login', () => '/login').then((to) => window.location.assign(to)); }}>
          <LogOut aria-hidden="true" />Sign out
        </Button>}
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

      <Pipeline state={state} expired={expired} pending={pending} errors={errors} post={post} />
      <Problems state={state} expired={expired} pending={pending} errors={errors} post={post} />
      <MutedChats state={state} expired={expired} pending={pending} errors={errors} post={post} />

      <TicketColumns id="tickets" board={board} title="Board" columns={columns} query={query}
        summary={(shown) => needle ? `${shown} matching "${needle}"` : `${tickets.length} tickets today, ${state.skipped.length} skipped batches`} />

      <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t pt-4 text-xs text-muted-foreground">
        <p>Dismissed: {state.feedback.dismiss_count}. Made tickets: {state.feedback.make_ticket_count}.</p>
        <p className="hidden flex-wrap items-center gap-x-3 gap-y-1 sm:flex">
          <Keyboard aria-hidden="true" className="size-4" />
          <span><Kbd>j</Kbd> <Kbd>k</Kbd> cards</span><span><Kbd>h</Kbd> <Kbd>l</Kbd> columns</span><span><Kbd>s</Kbd> Start</span><span><Kbd>c</Kbd> Discuss</span><span><Kbd>d</Kbd> Dismiss</span><span><Kbd>e</Kbd> Expand</span><span><Kbd>/</Kbd> search</span><span><Kbd>Esc</Kbd> close</span>
        </p>
        <p role="status" aria-live="polite" className="w-full">{notice}</p>
      </footer>
    </div>
  </div>;
}
