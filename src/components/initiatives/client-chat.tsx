'use client';

import { ExternalLink, Minus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientChatOpen, ClientChatStatus } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { ChatFrame, chatWebUrl, useChatFrame } from '../tickets/chat-frame.tsx';

// Where the bubble sits and whether its panel is open, kept across the Overview and the guide
export const CLIENT_CHAT_KEY = 'everflow.clientChat';
const SIZE = 50;
const MARGIN = 8;
const PANEL = { width: 400, height: 600 };
const STATUS_MS = 10_000;

// The EverTranscript Prompter sparkles
export function Sparkles({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true" className={className}>
    <path d="M12 3.5l1.9 4.9 4.9 1.9-4.9 1.9-1.9 4.9-1.9-4.9-4.9-1.9 4.9-1.9z" /><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
  </svg>;
}

type Place = { x: number; y: number; open: boolean };

function stored(): Place | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(CLIENT_CHAT_KEY) ?? 'null') as Partial<Place> | null;
    return value && typeof value.x === 'number' && typeof value.y === 'number' ? { x: value.x, y: value.y, open: value.open === true } : null;
  } catch { return null; }
}

// Inside the viewport, room left for the client name under the bubble
function clamp(place: Place): Place {
  return { ...place, x: Math.min(Math.max(MARGIN, place.x), Math.max(MARGIN, window.innerWidth - SIZE - MARGIN)),
    y: Math.min(Math.max(MARGIN, place.y), Math.max(MARGIN, window.innerHeight - SIZE - MARGIN - 16)) };
}

const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const dayMonth = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

async function failureMessage(response: Response): Promise<string> {
  const failure = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
  return typeof failure?.error?.message === 'string' ? failure.error.message : `Chat unavailable (${response.status})`;
}

// The client's chat of the day on the Overview and the guide ([web] chat_origin): a bubble that drags anywhere, toggles a panel
// that leaves the page usable, and shows a green dot while the chat runs a turn. A client of another initiative gets its own
// chat; the same client keeps the same one.
export function ClientChat(props: { client: string | null | undefined; origin: string | null | undefined; token: string }) {
  if (!props.client || !props.origin) return null;
  return <Bubble client={props.client} origin={props.origin} token={props.token} />;
}

function Bubble({ client, origin, token }: { client: string; origin: string; token: string }) {
  const [place, setPlace] = useState<Place | null>(null);
  const [phone, setPhone] = useState(false);
  const [status, setStatus] = useState<ClientChatStatus | null>(null);
  // the panel stays mounted once opened, so minimizing keeps the chat as it is
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const first = clamp(stored() ?? { x: window.innerWidth - SIZE - 24, y: window.innerHeight - SIZE - 40, open: false });
    setPlace(first);
    if (first.open) setShown(true);
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 639px)') : null;
    setPhone(!!media?.matches);
    const changed = () => setPhone(!!media?.matches);
    media?.addEventListener('change', changed);
    const resize = () => setPlace((current) => current && clamp(current));
    window.addEventListener('resize', resize);
    return () => { media?.removeEventListener('change', changed); window.removeEventListener('resize', resize); };
  }, []);
  useEffect(() => { if (place) window.localStorage.setItem(CLIENT_CHAT_KEY, JSON.stringify(place)); }, [place]);

  const post = useCallback(async (action: 'open' | 'status') => {
    const response = await fetch(`/api/client-chat/${encodeURIComponent(client)}/${action}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-everflow-token': token }, body: '{}' });
    if (!response.ok) throw new Error(await failureMessage(response));
    return response.json() as Promise<unknown>;
  }, [client, token]);
  const refresh = useCallback(() => { void post('status').then((value) => setStatus(value as ClientChatStatus), () => {}); }, [post]);
  useEffect(() => {
    setStatus(null);
    refresh();
    const timer = setInterval(refresh, STATUS_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const open = !!place?.open;
  const toggle = (next: boolean) => { setPlace((current) => current && { ...current, open: next }); if (next) setShown(true); };

  const drag = useRef<{ dx: number; dy: number; x: number; y: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!place || event.button !== 0) return;
    drag.current = { dx: event.clientX - place.x, dy: event.clientY - place.y, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    if (!start) return;
    if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
    start.moved = true;
    setPlace((current) => current && clamp({ ...current, x: event.clientX - start.dx, y: event.clientY - start.dy }));
  };
  const onPointerUp = () => { moved.current = !!drag.current?.moved; drag.current = null; };

  if (!place) return null;
  const running = !!status?.running;
  return <>
    {shown && <Panel client={client} origin={origin} place={place} phone={phone} hidden={!open} open={() => post('open') as Promise<ClientChatOpen>}
      onOpened={refresh} onMinimize={() => toggle(false)} />}
    {/* on a phone the open panel takes the screen; its header minimizes it */}
    <div data-client-chat="" hidden={phone && open} className={cn('fixed z-50 flex flex-col items-center gap-1', phone && open && 'hidden')} style={{ left: place.x, top: place.y, width: SIZE }}>
      <button type="button" aria-expanded={open} aria-label={open ? `Riduci la chat di ${client}` : `Apri la chat di ${client}`} title={`Chat di oggi · ${client}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onClick={() => { if (moved.current) { moved.current = false; return; } toggle(!open); }}
        className="relative flex size-[50px] touch-none items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-1 ring-black/5 transition-transform select-none hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:cursor-grabbing">
        <Sparkles className="size-6" />
        {running && <span data-running="" aria-label="La chat sta lavorando" className="absolute top-0.5 right-0.5 size-3 rounded-full border-2 border-background bg-success" />}
      </button>
      <span className="max-w-24 truncate rounded bg-background/90 px-1 text-[11px] font-medium text-foreground shadow-xs">{client}</span>
    </div>
  </>;
}

// Non-modal: about 400x600 next to the bubble on a desktop, the whole screen on a phone
function Panel(props: { client: string; origin: string; place: Place; phone: boolean; hidden: boolean; open: () => Promise<ClientChatOpen>; onOpened: () => void; onMinimize: () => void }) {
  const { client, origin, place } = props;
  const opened = useRef(props.onOpened);
  opened.current = props.onOpened;
  const chat = useChatFrame({ id: client, origin, open: () => props.open().then((value) => { opened.current(); return value; }), onClose: props.onMinimize });
  const day = (chat.opened as ClientChatOpen | null)?.day ?? today();
  const session = chat.opened?.session_id;
  const style = (() => {
    if (props.phone || typeof window === 'undefined') return undefined;
    const width = Math.min(PANEL.width, window.innerWidth - 2 * MARGIN), height = Math.min(PANEL.height, window.innerHeight - 2 * MARGIN);
    const right = place.x + SIZE / 2 > window.innerWidth / 2;
    const fit = (value: number, size: number, room: number) => Math.min(Math.max(MARGIN, value), room - size - MARGIN);
    // under the bubble, else over it, else beside it, so it never covers the bubble
    const under = place.y + SIZE + 24, over = place.y - height - 12;
    if (under + height <= window.innerHeight - MARGIN || over >= MARGIN) {
      return { width, height, left: fit(right ? place.x + SIZE - width : place.x, width, window.innerWidth), top: under + height <= window.innerHeight - MARGIN ? under : over };
    }
    return { width, height, left: fit(right ? place.x - width - 12 : place.x + SIZE + 12, width, window.innerWidth), top: fit(place.y + SIZE / 2 - height / 2, height, window.innerHeight) };
  })();
  return <section role="dialog" aria-modal="false" aria-label={`Chat di ${client}`} hidden={props.hidden} style={style}
    className={cn('fixed z-50 flex flex-col overflow-hidden border bg-card shadow-2xl', props.phone ? 'inset-0' : 'rounded-xl', props.hidden && 'hidden')}>
    <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"><Sparkles className="size-4" /></span>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-sm font-semibold">{client}</p>
        <p className="text-[11px] text-muted-foreground">chat di oggi · {dayMonth(day)}</p>
      </div>
      {session && <a href={chatWebUrl(origin, session)} target="_blank" rel="noopener" aria-label={`Apri la chat di ${client} in OpenChamber`}
        className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
        OpenChamber<ExternalLink aria-hidden="true" className="size-3" /></a>}
      <button type="button" onClick={props.onMinimize} aria-label="Riduci la chat" title="Riduci"
        className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring', !session && 'ml-auto')}>
        <Minus aria-hidden="true" className="size-4" /></button>
    </header>
    <div className="flex min-h-0 flex-1 flex-col"><ChatFrame chat={chat} title={`Chat di ${client}`} /></div>
  </section>;
}
