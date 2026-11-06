'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { SourceMessage, TicketCard as CardData, TicketDetail } from '../../lib/web-types.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { Card, CardContent, CardHeader } from '../ui/card.tsx';
import { Checkbox } from '../ui/checkbox.tsx';
import { ScrollArea } from '../ui/scroll-area.tsx';
import { Separator } from '../ui/separator.tsx';
import { ActionDialog } from './action-dialog.tsx';

export function SafeLink({ url, children }: { url: string | null; children: React.ReactNode }) {
  let safe: string | undefined;
  try {
    const value = new URL(url ?? '');
    if (['http:', 'https:'].includes(value.protocol) && !value.username && !value.password) safe = value.href;
  } catch { /* Invalid references remain literal text. */ }
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{children}</a> : <span>{children}</span>;
}

export function Messages({ messages }: { messages: SourceMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <div>
    <Button variant="ghost" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>Messages ({messages.length})</Button>
    {expanded && <ScrollArea id={id} className="mt-2 rounded-md border p-3 [&_[data-slot=scroll-area-viewport]]:max-h-80">
      <ol aria-label="Source messages" className="space-y-3">
        {messages.map((message) => <li key={message.id}>
          <p className="text-sm text-muted-foreground">{message.source} · {message.sender ?? 'Unknown sender'} · <time dateTime={message.sent_at}>{message.sent_at}</time></p>
          <p className="whitespace-pre-wrap">{message.text ?? '(no text)'}</p>
        </li>)}
      </ol>
      {messages.length === 0 && <p className="text-sm text-muted-foreground">No source messages.</p>}
    </ScrollArea>}
  </div>;
}

function Timeline({ ticket, revision }: { ticket: number; revision: number }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [error, setError] = useState('');
  const id = useId();
  const loaded = useRef('');
  useEffect(() => {
    const version = `${ticket}:${revision}`;
    if (!expanded || loaded.current === version) return;
    const controller = new AbortController();
    setError('');
    void fetch(`/api/ticket/${ticket}`, { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(`Timeline unavailable (${response.status})`);
      const next = await response.json() as TicketDetail;
      if (!Array.isArray(next.timeline)) throw new Error('Invalid timeline response');
      if (!controller.signal.aborted) { loaded.current = version; setDetail(next); }
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Timeline unavailable'); });
    return () => controller.abort();
  }, [expanded, revision, ticket]);
  return <div>
    <Button variant="ghost" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => { setError(''); setExpanded(!expanded); }}>Timeline</Button>
    {expanded && <div id={id} className="mt-2 rounded-md border p-3">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!detail && !error && <p role="status">Loading timeline...</p>}
      {detail && <ol aria-label="Timeline events" className="space-y-3">
        {detail.timeline.map((event) => <li key={event.id}>
          <p className="text-sm text-muted-foreground"><time dateTime={event.at}>{event.at}</time> · {event.actor} · {event.kind}</p>
          <p className="whitespace-pre-wrap"><SafeLink url={event.link}>{event.body}</SafeLink></p>
        </li>)}
        {detail.timeline.length === 0 && <li>No timeline events.</li>}
      </ol>}
    </div>}
  </div>;
}

export function TicketCard(props: {
  ticket: CardData;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  enabled: boolean;
  chats: boolean;
  expired: boolean;
  pending: ReadonlySet<string>;
  errors: Record<string, string>;
  post: (key: string, path: string, input?: Record<string, string>) => Promise<unknown>;
  now: number;
  revision: number;
}) {
  const { ticket, post } = props;
  const heading = useId();
  const keys = { start: `ticket:${ticket.id}:start`, chat: `ticket:${ticket.id}:chat`, dismiss: `ticket:${ticket.id}:dismiss` };
  const terminal = ticket.lifecycle === 'done' || ticket.lifecycle === 'dismissed';
  const error = props.errors[keys.start] || props.errors[keys.chat] || props.errors[keys.dismiss];
  const minutes = Math.max(0, Math.floor((props.now - Date.parse(ticket.created_at)) / 60_000));
  const age = minutes < 60 ? `${minutes}m` : minutes < 1_440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1_440)}d`;
  return <article tabIndex={-1} aria-labelledby={heading} data-ticket-id={ticket.id} className="rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
    <Card className="gap-3 py-4 shadow-none">
      <CardHeader className="gap-2 px-4">
        <div className="flex flex-wrap items-center gap-2">
          {props.enabled && !terminal && <Checkbox checked={props.selected} onCheckedChange={(checked) => props.onSelect(checked === true)} aria-label={`Select ticket #${ticket.id}`} className="size-6" />}
          <span className="text-sm font-medium">{ticket.client ?? 'Unassigned'}</span>
          <Badge variant="secondary">{ticket.lifecycle === 'proposed' ? 'Proposed' : ticket.stage}</Badge>
          {ticket.lifecycle === 'proposed' && ticket.stage === 'Failed' && <Badge variant="destructive">Failed</Badge>}
          <span className="ml-auto text-sm text-muted-foreground"><time dateTime={ticket.created_at} title={ticket.created_at}>Age: {age}</time></span>
        </div>
        <h3 id={heading} className="text-base font-semibold">Ticket #{ticket.id}: {ticket.title}</h3>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {ticket.confidence !== null && <span>Confidence: {Math.round(ticket.confidence * 100)}%</span>}
          {ticket.maybe_ticket !== null && <span>Maybe #{ticket.maybe_ticket}</span>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {ticket.summary && <p className="whitespace-pre-wrap text-sm">{ticket.summary}</p>}
        {ticket.lifecycle === 'proposed' && <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="font-medium">Ask</dt><dd className="whitespace-pre-wrap">{ticket.ask || '(none)'}</dd></div>
          <div><dt className="font-medium">Proposal</dt><dd className="whitespace-pre-wrap">{ticket.proposal || '(none)'}</dd></div>
        </dl>}
        {ticket.lifecycle !== 'proposed' && <div className="space-y-1 text-sm">
          <p><span className="font-medium">Stage:</span> {ticket.stage}{ticket.report ? ` · ${ticket.report}` : ''}</p>
          {ticket.report_line && <p className="whitespace-pre-wrap">{ticket.report_line}</p>}
          {ticket.session_title && <p><span className="font-medium">Session title:</span> {ticket.session_title}</p>}
        </div>}
        {ticket.kb_notes.length > 0 && <div className="text-sm"><p className="font-medium">KB paths</p><ul>{ticket.kb_notes.map((path, index) => <li key={`${index}:${path}`}><code>{path}</code></li>)}</ul></div>}
        {ticket.refs.length > 0 && <ul aria-label="References" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{ticket.refs.map((ref) => <li key={ref.id}><SafeLink url={ref.url}>{ref.key}</SafeLink></li>)}</ul>}
        <div className="grid gap-1"><Messages messages={ticket.messages} /><Timeline ticket={ticket.id} revision={props.revision} /></div>
        {props.enabled && !terminal && <>
          <Separator />
          <div className="flex flex-wrap gap-2">
            {ticket.lifecycle === 'proposed' && props.chats && <>
              <Button type="button" data-shortcut="s" disabled={props.expired || props.pending.has(keys.start)} onClick={() => { void post(keys.start, `/api/ticket/${ticket.id}/start`).catch(() => {}); }}>
                {props.pending.has(keys.start) ? 'Saving Start' : 'Start'}
              </Button>
              <ActionDialog label="Open chat with note" title={`Open chat for ticket #${ticket.id}`} confirm="Approve with note" note shortcut="c"
                disabled={props.expired || props.pending.has(keys.chat)} onConfirm={(note) => post(keys.chat, `/api/ticket/${ticket.id}/chat`, { note })} />
            </>}
            <ActionDialog label="Dismiss" title={`Dismiss ticket #${ticket.id}`} confirm="Confirm dismiss" shortcut="d" disabled={props.expired || props.pending.has(keys.dismiss)}
              onConfirm={(reason) => post(keys.dismiss, `/api/ticket/${ticket.id}/dismiss`, { reason })} />
          </div>
        </>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  </article>;
}
