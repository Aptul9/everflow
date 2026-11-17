'use client';

import { ExternalLink, LoaderCircle, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';

export type OpenChat = (ticket: number) => Promise<{ session_id: string; directory: string }>;

// The ticket's chat managed from the board: OpenChamber's own chat view (mini-chat.html: messages, context gauge, composer
// with model and agent) framed from the chat host, which carries the same sign-in. The server first resolves the folder
// OpenChamber keeps the session in and registers it, without which the view opens empty.
export function ChatDialog(props: { ticket: { id: number; title: string; session_id: string } | null; origin: string; open: OpenChat; onClose: () => void }) {
  const { ticket } = props;
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const { open, origin } = props;
  const id = ticket?.id, session = ticket?.session_id;
  // keyed on the ticket and session, not the card object: a board refresh must not reload a chat in use
  useEffect(() => {
    setSrc(''); setError('');
    if (id === undefined || !session) return;
    let current = true;
    void open(id).then((chat) => {
      if (current) setSrc(`${origin}/mini-chat.html?${new URLSearchParams({ mode: 'session', sessionId: chat.session_id, directory: chat.directory })}`);
    }, (failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : 'Chat unavailable'); });
    return () => { current = false; };
  }, [id, session, open, origin]);
  const encoded = encodeURIComponent(session ?? '');
  return <Dialog open={!!ticket} onOpenChange={(next) => { if (!next) props.onClose(); }}>
    {/* The chat view already shows the session title, so the ticket title stays for screen readers only. Desktop: a column
        as wide as the chat needs (its messages and composer stop near 900 px) and as tall as the window less a small margin;
        the links and Close sit in the chat's own header row, in the empty space left of its context gauge, pin and pop-out
        buttons (about 160 px from the right edge in OpenChamber 2.7.2). Phone: full screen, links in a slim strip on top. */}
    <DialogContent showCloseButton={false}
      className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:h-[calc(100dvh-1.5rem)] sm:w-[min(1100px,96vw)] sm:max-w-none sm:rounded-lg">
      <DialogTitle className="sr-only"><span>#{ticket?.id}</span>{ticket?.title}</DialogTitle>
      <DialogDescription className="sr-only">Chat of this ticket in OpenChamber</DialogDescription>
      <div className="flex shrink-0 items-center justify-end gap-1 border-b px-2 py-1 text-xs sm:absolute sm:top-2 sm:right-[176px] sm:z-10 sm:rounded-md sm:border-0 sm:bg-background sm:p-0">
        <a href={`openchamber://session/${encoded}`} aria-label={`Open the chat of ticket #${ticket?.id} in the OpenChamber app`}
          className="rounded px-2 py-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">App</a>
        <a href={`${origin}/?session=${encoded}`} target="_blank" rel="noopener" aria-label={`Open the chat of ticket #${ticket?.id} in OpenChamber`}
          className="inline-flex items-center gap-1 rounded px-2 py-1 font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          OpenChamber<ExternalLink aria-hidden="true" className="size-3" />
        </a>
        <DialogClose aria-label="Close" className="ml-1 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <XIcon aria-hidden="true" className="size-4" />
        </DialogClose>
      </div>
      {src ? <iframe key={src} src={src} title={`Chat of ticket #${ticket?.id}`} allow="clipboard-read; clipboard-write; microphone"
        className="min-h-0 w-full flex-1 border-0 bg-background sm:rounded-lg" />
        : <div className="flex flex-1 items-center justify-center p-6 text-sm">
          {error ? <p role="alert" className="max-w-md rounded-md bg-destructive-soft px-3 py-2 text-destructive">{error}</p>
            : <p role="status" className="inline-flex items-center gap-2 text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Opening the chat...</p>}
        </div>}
    </DialogContent>
  </Dialog>;
}
