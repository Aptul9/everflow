'use client';

import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { cn } from '../../lib/utils.ts';

/** How long the chat view gets, once loaded, to say its bridge runs before the page shows its own Close again. */
export const BRIDGE_WAIT_MS = 6_000;

// OpenChamber's own chat view (mini-chat.html: messages, context gauge, composer with model and agent) on the chat host,
// which carries the page's sign-in; it finds the session only in the folder OpenChamber keeps it in
export function chatViewUrl(origin: string, session: string, directory: string): string {
  return `${origin}/mini-chat.html?${new URLSearchParams({ mode: 'session', sessionId: session, directory })}`;
}

// The same chat in OpenChamber's full web UI
export function chatWebUrl(origin: string, session: string): string {
  return `${origin}/?session=${encodeURIComponent(session)}`;
}

export type OpenedChat = { session_id: string; directory: string };

// A chat framed on the page, for the board's chat dialog and the Overview's client chat. id names the chat (ticket and session,
// or client): a new id opens it again, a page refresh does not. open resolves the session and its folder, which the server
// registers with OpenChamber first, without which the view opens empty. The chat host adds Everflow's bridge to the view:
// it says it runs, its Close closes the page's dialog or panel, and a file clicked in the chat goes to onOpenFile. Messages
// count only from that frame and the chat host's origin.
export function useChatFrame(props: { id: string | null; origin: string; open: () => Promise<OpenedChat>; onClose: () => void; onOpenFile?: (path: string) => void }) {
  const { id, origin } = props;
  const [src, setSrc] = useState('');
  const [opened, setOpened] = useState<OpenedChat | null>(null);
  const [error, setError] = useState('');
  const handlers = useRef(props);
  handlers.current = props;
  useEffect(() => {
    setSrc(''); setError(''); setOpened(null);
    if (id === null) return;
    let current = true;
    void handlers.current.open().then((chat) => {
      if (current) { setOpened(chat); setSrc(chatViewUrl(origin, chat.session_id, chat.directory)); }
    }, (failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : 'Chat unavailable'); });
    return () => { current = false; };
  }, [id, origin]);

  const frame = useRef<HTMLIFrameElement>(null);
  const [bridged, setBridged] = useState(false);
  const [late, setLate] = useState(false);
  const loaded = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { setBridged(false); setLate(false); return () => clearTimeout(loaded.current); }, [src]);
  useEffect(() => {
    let expected: string;
    try { expected = new URL(origin).origin; } catch { return; }
    const listener = (event: MessageEvent) => {
      if (event.origin !== expected || !frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as { type?: unknown; path?: unknown } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'everflow:ready') setBridged(true);
      else if (data.type === 'everflow:close') handlers.current.onClose();
      else if (data.type === 'everflow:open-file' && typeof data.path === 'string' && data.path && data.path.length <= 4096) handlers.current.onOpenFile?.(data.path);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [origin]);
  const onLoad = () => {
    clearTimeout(loaded.current);
    loaded.current = setTimeout(() => setLate(true), BRIDGE_WAIT_MS);
  };
  // the chat view's own Close (the bridge) replaces the page's; without a chat view or a bridge, the page keeps one
  return { src, opened, error, frame, onLoad, ownClose: !src || late && !bridged };
}

export function ChatFrame({ chat, title, className }: { chat: ReturnType<typeof useChatFrame>; title: string; className?: string }) {
  return chat.src ? <iframe ref={chat.frame as Ref<HTMLIFrameElement>} key={chat.src} src={chat.src} title={title} allow="clipboard-read; clipboard-write; microphone" onLoad={chat.onLoad}
    className={cn('min-h-0 w-full flex-1 border-0 bg-background', className)} />
    : <div className="flex flex-1 items-center justify-center p-6 text-sm">
      {chat.error ? <p role="alert" className="max-w-md rounded-md bg-destructive-soft px-3 py-2 text-destructive">{chat.error}</p>
        : <p role="status" className="inline-flex items-center gap-2 text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Opening the chat...</p>}
    </div>;
}
