'use client';

import { BookOpen, Check, Clock, GitCommitVertical, LoaderCircle, Maximize2, MessageSquarePlus, MessagesSquare, Play, RotateCw, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { SourceMessage, TicketCard as CardData, TicketDetail } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { Checkbox } from '../ui/checkbox.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog.tsx';
import { ScrollArea } from '../ui/scroll-area.tsx';
import { ActionDialog } from './action-dialog.tsx';

export type Tone = 'needs' | 'working' | 'waiting' | 'failed' | 'done' | 'skipped';

export const tones: Record<Tone, { dot: string; badge: string; bar: string }> = {
  needs: { dot: 'bg-primary', badge: 'bg-accent text-accent-foreground', bar: 'bg-primary' },
  working: { dot: 'bg-info', badge: 'bg-info-soft text-info', bar: 'bg-info' },
  waiting: { dot: 'bg-warning', badge: 'bg-warning-soft text-warning', bar: 'bg-warning' },
  failed: { dot: 'bg-destructive', badge: 'bg-destructive-soft text-destructive', bar: 'bg-destructive' },
  done: { dot: 'bg-success', badge: 'bg-success-soft text-success', bar: 'bg-success' },
  skipped: { dot: 'bg-input', badge: 'bg-muted text-muted-foreground', bar: 'bg-input' },
};

function tone(ticket: CardData): Tone {
  if (ticket.lifecycle === 'dismissed') return 'skipped';
  if (ticket.lifecycle === 'done') return 'done';
  if (ticket.stage === 'Failed') return 'failed';
  if (ticket.lifecycle === 'proposed' || ticket.stage === 'Needs you') return 'needs';
  return ticket.stage === 'Waiting on them' ? 'waiting' : 'working';
}

export function formatTime(value: string | null): string {
  const date = new Date(value ?? '');
  if (!value || Number.isNaN(date.getTime())) return value ?? '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function Time({ value, className }: { value: string; className?: string }) {
  return <time dateTime={value} title={value} className={cn('tabular-nums', className)} suppressHydrationWarning>{formatTime(value)}</time>;
}

export function SafeLink({ url, children, className }: { url: string | null; children: React.ReactNode; className?: string }) {
  let safe: string | undefined;
  try {
    const value = new URL(url ?? '');
    if (['http:', 'https:'].includes(value.protocol) && !value.username && !value.password) safe = value.href;
  } catch { /* Invalid references remain literal text. */ }
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer" className={cn('text-primary underline-offset-2 hover:underline', className)}>{children}</a> : <span className={className}>{children}</span>;
}

export function Toggle({ expanded, controls, onClick, icon, children }: { expanded: boolean; controls: string; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return <Button variant="ghost" size="xs" type="button" aria-expanded={expanded} aria-controls={controls} onClick={onClick}
    className={cn('h-7 min-w-0 px-1.5 text-muted-foreground hover:text-foreground', expanded && 'bg-muted text-foreground')}>
    {icon}{children}
  </Button>;
}

export function MessageList({ id, messages }: { id: string; messages: SourceMessage[] }) {
  return <ScrollArea id={id} className="rounded-md border bg-muted/40 [&_[data-slot=scroll-area-viewport]]:max-h-72">
    <ol aria-label="Source messages" className="divide-y">
      {messages.map((message) => <li key={message.id} className="space-y-0.5 px-2.5 py-2">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{message.sender ?? 'Unknown sender'}</span>
          <span className="rounded bg-background px-1 font-mono text-[10px]">{message.source}</span>
          <Time value={message.sent_at} />
        </p>
        <p className="text-[13px] whitespace-pre-wrap">{message.text ?? '(no text)'}</p>
      </li>)}
    </ol>
    {messages.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">No source messages.</p>}
  </ScrollArea>;
}

function Timeline({ id, ticket, revision }: { id: string; ticket: number; revision: string }) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [error, setError] = useState('');
  const loaded = useRef('');
  useEffect(() => {
    const version = `${ticket}:${revision}`;
    if (loaded.current === version) return;
    const controller = new AbortController();
    setError('');
    void fetch(`/api/ticket/${ticket}`, { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(`Timeline unavailable (${response.status})`);
      const next = await response.json() as TicketDetail;
      if (!Array.isArray(next.timeline)) throw new Error('Invalid timeline response');
      if (!controller.signal.aborted) { loaded.current = version; setDetail(next); }
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Timeline unavailable'); });
    return () => controller.abort();
  }, [revision, ticket]);
  return <div id={id} className="rounded-md border bg-muted/40 px-2.5 py-2">
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {!detail && !error && <p role="status" className="text-xs text-muted-foreground">Loading timeline...</p>}
    {detail && <ol aria-label="Timeline events" className="space-y-2.5 border-l pl-3">
      {detail.timeline.map((event) => <li key={event.id} className="relative">
        <span aria-hidden="true" className="absolute top-1.5 -left-[17px] size-2 rounded-full border-2 border-card bg-input" />
        <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground"><Time value={event.at} /><span>{event.actor}</span><span className="rounded bg-background px-1 font-mono text-[10px]">{event.kind}</span></p>
        <p className="text-[13px] whitespace-pre-wrap"><SafeLink url={event.link}>{event.body}</SafeLink></p>
      </li>)}
      {detail.timeline.length === 0 && <li className="text-xs text-muted-foreground">No timeline events.</li>}
    </ol>}
  </div>;
}

export function age(now: number, at: string): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  return minutes < 60 ? `${minutes}m` : minutes < 1_440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1_440)}d`;
}

export function Field({ label, expanded, children }: { label: string; expanded: boolean; children: React.ReactNode }) {
  return <div className="min-w-0 rounded-md bg-muted/70 px-2.5 py-1.5">
    <dt className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
    <dd className={cn('text-[13px] whitespace-pre-wrap', !expanded && 'line-clamp-4')}>{children}</dd>
  </div>;
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-1.5">
    <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
    {children}
  </section>;
}

// Full text of a card in a popup; the card itself stays a clamped preview
export function Expand({ label, title, meta, children }: { label: string; title: string; meta: React.ReactNode; children: React.ReactNode }) {
  return <Dialog>
    <DialogTrigger asChild>
      <Button variant="ghost" size="xs" type="button" data-shortcut="e" aria-label={label} title={`${label} (e)`} className="h-7 px-1.5 text-muted-foreground hover:text-foreground">
        <Maximize2 aria-hidden="true" />Expand
      </Button>
    </DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto sm:max-w-3xl">
      <DialogHeader className="gap-1.5 pr-6 text-left">
        <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">{meta}</DialogDescription>
        <DialogTitle className="text-lg leading-snug">{title}</DialogTitle>
      </DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}

function Notes({ ticket }: { ticket: CardData }) {
  if (ticket.refs.length === 0 && ticket.kb_notes.length === 0) return null;
  return <div className="flex flex-wrap gap-1 text-[11px]">
    {ticket.refs.length > 0 && <ul aria-label="References" className="flex flex-wrap gap-1">{ticket.refs.map((ref) => <li key={ref.id}>
      <SafeLink url={ref.url} className="inline-flex items-center rounded border border-primary/20 bg-accent px-1.5 py-px font-medium text-accent-foreground">{ref.key}</SafeLink>
    </li>)}</ul>}
    {ticket.kb_notes.length > 0 && <ul aria-label="KB paths" className="flex min-w-0 flex-wrap gap-1">{ticket.kb_notes.map((path, index) => <li key={`${index}:${path}`} title={path}
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded border bg-muted px-1.5 py-px text-muted-foreground">
      <BookOpen aria-hidden="true" className="size-3 shrink-0" /><code className="font-mono break-all">{path}</code>
    </li>)}</ul>}
  </div>;
}

function TicketDetails({ ticket, now, badge }: { ticket: CardData; now: number; badge: string }) {
  const messagesId = useId();
  const timelineId = useId();
  return <Expand label={`Expand ticket #${ticket.id}`} title={ticket.title} meta={<>
    <Badge className={cn('border-transparent px-1.5 text-[11px]', badge)}>{ticket.lifecycle === 'proposed' ? 'Proposed' : ticket.stage}</Badge>
    {ticket.confidence !== null && <span><span className="font-medium text-foreground tabular-nums">{Math.round(ticket.confidence * 100)}%</span> conf.</span>}
    {ticket.maybe_ticket !== null && <span className="rounded border border-dashed px-1">Maybe #{ticket.maybe_ticket}</span>}
    <span className="font-semibold text-foreground">{ticket.client ?? 'Unassigned'}</span>
    <span>Age: {age(now, ticket.created_at)}</span>
    <span className="font-mono">#{ticket.id}</span>
  </>}>
    {ticket.summary && <p className="text-sm whitespace-pre-wrap">{ticket.summary}</p>}
    <dl className="grid gap-2">
      {ticket.lifecycle === 'proposed' && <>
        <Field label="Ask" expanded>{ticket.ask || '(none)'}</Field>
        <Field label="Proposal" expanded>{ticket.proposal || '(none)'}</Field>
      </>}
      {ticket.report_line && <Field label="Report" expanded>{ticket.report_line}</Field>}
      {ticket.reason && <Field label="Why" expanded>{ticket.reason}</Field>}
      {ticket.session_title && <Field label="Session" expanded>{ticket.session_title}</Field>}
    </dl>
    <Notes ticket={ticket} />
    <Section title={`Messages (${ticket.messages.length})`}><MessageList id={messagesId} messages={ticket.messages} /></Section>
    <Section title="Timeline"><Timeline id={timelineId} ticket={ticket.id} revision={ticket.timeline_revision} /></Section>
  </Expand>;
}

export function TicketCard(props: {
  ticket: CardData;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  enabled: boolean;
  chats: boolean;
  chatProject?: string;
  expired: boolean;
  pending: ReadonlySet<string>;
  errors: Record<string, string>;
  post: (key: string, path: string, input?: Record<string, string | number | null>) => Promise<unknown>;
  now: number;
  onDrag?: (dragging: boolean) => void;
}) {
  const { ticket, post } = props;
  const heading = useId();
  const messagesId = useId();
  const timelineId = useId();
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const keys = { start: `ticket:${ticket.id}:start`, chat: `ticket:${ticket.id}:chat`, dismiss: `ticket:${ticket.id}:dismiss`, close: `ticket:${ticket.id}:close`, clear: `ticket:${ticket.id}:clear` };
  const terminal = ticket.lifecycle === 'done' || ticket.lifecycle === 'dismissed';
  const error = props.errors[keys.start] || props.errors[keys.chat] || props.errors[keys.dismiss] || props.errors[keys.close] || props.errors[keys.clear];
  const compact = ticket.lifecycle === 'proposed' && props.chats;
  const style = tones[tone(ticket)];
  const actions = props.enabled && !terminal;
  const starting = props.pending.has(keys.start);
  return <article tabIndex={-1} aria-labelledby={heading} data-ticket-id={ticket.id} draggable={actions}
    onDragStart={(event) => { event.dataTransfer?.setData('text/plain', `#${ticket.id}`); props.onDrag?.(true); }} onDragEnd={() => props.onDrag?.(false)}
    className={cn('group/card scroll-mt-28 rounded-lg border bg-card shadow-xs transition-[box-shadow,border-color] hover:border-foreground/15 hover:shadow-sm', actions && 'cursor-grab active:cursor-grabbing',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', props.selected && 'border-primary/40 bg-accent/40')}>
    <div className="space-y-2 p-3">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {props.enabled && <Checkbox checked={props.selected} onCheckedChange={(checked) => props.onSelect(checked === true)} aria-label={`Select ticket #${ticket.id}`} className="size-4.5" />}
        <span className="min-w-0 truncate font-semibold" title={ticket.client ?? undefined}>{ticket.client ?? 'Unassigned'}</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-muted-foreground"><Clock aria-hidden="true" className="size-3" /><time dateTime={ticket.created_at} title={ticket.created_at} className="tabular-nums">Age: {age(props.now, ticket.created_at)}</time></span>
        {props.enabled && terminal && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Clear ticket #${ticket.id}`} title="Clear from the board (the ticket is kept)"
          className="-my-1 -mr-1.5 size-7 shrink-0 text-muted-foreground hover:text-foreground" disabled={props.expired || props.pending.has(keys.clear)}
          onClick={() => { void post(keys.clear, `/api/ticket/${ticket.id}/clear`).catch(() => {}); }}><X aria-hidden="true" /></Button>}
      </div>
      <h4 id={heading} className="text-sm leading-snug font-semibold"><span className="sr-only">{`Ticket #${ticket.id}:`}</span>{' '}{ticket.title}</h4>
      {ticket.session_id && !terminal && <p title={`Session ${ticket.session_id}`} className="flex min-w-0 items-center gap-1.5 rounded-md bg-info-soft px-2 py-1 text-xs font-medium text-info">
        {ticket.chat_running ? <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin" /> : <MessagesSquare aria-hidden="true" className="size-3.5 shrink-0" />}
        <span className="min-w-0">{`${ticket.chat_running ? 'Chat working now' : 'Chat open in OpenChamber'}${props.chatProject ? `, project ${props.chatProject}` : ''}`}</span>
      </p>}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <Badge className={cn('border-transparent px-1.5 text-[11px]', style.badge)}>{ticket.lifecycle === 'proposed' ? 'Proposed' : ticket.stage}</Badge>
        {ticket.lifecycle === 'proposed' && ticket.stage === 'Failed' && <Badge variant="destructive" className="px-1.5 text-[11px]">Failed</Badge>}
        {ticket.confidence !== null && <span className="text-muted-foreground"><span className="font-medium text-foreground tabular-nums">{Math.round(ticket.confidence * 100)}%</span> conf.</span>}
        {ticket.maybe_ticket !== null && <span className="rounded border border-dashed px-1 text-muted-foreground">Maybe #{ticket.maybe_ticket}</span>}
        <span className="ml-auto font-mono text-muted-foreground">#{ticket.id}</span>
      </div>
      {/* The card is a glance: the AI sum-up, or the chat's latest status once it runs; the rest is in Expand */}
      {(ticket.lifecycle !== 'proposed' && ticket.report_line || ticket.summary) && <p className="line-clamp-2 text-[13px] whitespace-pre-wrap">
        {ticket.lifecycle !== 'proposed' && ticket.report_line || ticket.summary}
      </p>}
      <TicketDetails ticket={ticket} now={props.now} badge={style.badge} />
      {error && <p role="alert" className="rounded-md bg-destructive-soft px-2.5 py-1.5 text-xs text-destructive">{error}</p>}
    </div>
    {/* Below the label width the main button keeps only its icon, so the icon buttons never wrap alone */}
    {actions && <div className="@container flex flex-wrap items-center gap-1.5 border-t px-3 py-2">
      {ticket.lifecycle === 'proposed' && props.chats && <>
        <Button type="button" size="sm" data-shortcut="s" data-action="start" title="Start (s)" aria-label={starting ? 'Saving Start' : 'Start'} className="h-9 min-w-0 flex-1 sm:h-8" disabled={props.expired || starting}
          onClick={() => { void post(keys.start, `/api/ticket/${ticket.id}/start`).catch(() => {}); }}>
          {starting ? <RotateCw aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}<span className="hidden truncate @[12rem]:inline">{starting ? 'Saving Start' : 'Start'}</span>
        </Button>
        <ActionDialog label="Open chat with note" display={null} title={`Open chat for ticket #${ticket.id}`} confirm="Approve with note" note shortcut="c" size="icon-sm"
          icon={<MessageSquarePlus aria-hidden="true" />} className="h-9 w-9 sm:h-8 sm:w-8" disabled={props.expired || props.pending.has(keys.chat)}
          onConfirm={(note) => post(keys.chat, `/api/ticket/${ticket.id}/chat`, { note })} />
      </>}
      <ActionDialog label="Mark done" display={compact ? null : 'Done'} title={`Mark ticket #${ticket.id} done`} confirm="Confirm done" safe action="done"
        placeholder="What was done by hand (optional)" size={compact ? 'icon-sm' : 'sm'} icon={<Check aria-hidden="true" />}
        className={cn('h-9 sm:h-8', compact ? 'w-9 sm:w-8' : 'flex-1')} disabled={props.expired || props.pending.has(keys.close)}
        onConfirm={(reason) => post(keys.close, `/api/ticket/${ticket.id}/close`, { reason })} />
      <ActionDialog label="Dismiss" display={ticket.lifecycle === 'proposed' && props.chats ? null : 'Dismiss'} title={`Dismiss ticket #${ticket.id}`} confirm="Confirm dismiss" shortcut="d" action="dismiss" mute="optional"
        size={ticket.lifecycle === 'proposed' && props.chats ? 'icon-sm' : 'sm'} icon={<X aria-hidden="true" />}
        className={cn('h-9 sm:h-8', ticket.lifecycle === 'proposed' && props.chats ? 'w-9 sm:w-8' : 'flex-1')} disabled={props.expired || props.pending.has(keys.dismiss)}
        onConfirm={(reason, mute) => post(keys.dismiss, `/api/ticket/${ticket.id}/dismiss`, mute === undefined ? { reason } : { reason, mute_hours: mute })} />
    </div>}
    <div className="flex flex-wrap items-center gap-1 border-t px-2 py-1">
      <Toggle expanded={messagesOpen} controls={messagesId} onClick={() => setMessagesOpen(!messagesOpen)} icon={<MessagesSquare aria-hidden="true" />}>Messages ({ticket.messages.length})</Toggle>
      <Toggle expanded={timelineOpen} controls={timelineId} onClick={() => setTimelineOpen(!timelineOpen)} icon={<GitCommitVertical aria-hidden="true" />}>Timeline</Toggle>
    </div>
    {(messagesOpen || timelineOpen) && <div className="space-y-2 px-2 pb-2">
      {messagesOpen && <MessageList id={messagesId} messages={ticket.messages} />}
      {timelineOpen && <Timeline id={timelineId} ticket={ticket.id} revision={ticket.timeline_revision} />}
    </div>}
  </article>;
}
