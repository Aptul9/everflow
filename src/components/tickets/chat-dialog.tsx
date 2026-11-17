'use client';

import { ExternalLink, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';

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
    <DialogContent className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[90vh] sm:w-[95vw] sm:max-w-none sm:rounded-lg">
      <div className="flex min-w-0 items-center gap-3 border-b py-2 pr-12 pl-4">
        <DialogTitle className="min-w-0 truncate text-sm leading-snug font-semibold">
          <span className="mr-1.5 font-mono text-muted-foreground">#{ticket?.id}</span>{ticket?.title}
        </DialogTitle>
        <DialogDescription className="sr-only">Chat of this ticket in OpenChamber</DialogDescription>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs">
          <a href={`openchamber://session/${encoded}`} aria-label={`Open the chat of ticket #${ticket?.id} in the OpenChamber app`}
            className="rounded px-1.5 py-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">App</a>
          <a href={`${origin}/?session=${encoded}`} target="_blank" rel="noopener" aria-label={`Open the chat of ticket #${ticket?.id} in OpenChamber`}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            OpenChamber<ExternalLink aria-hidden="true" className="size-3" />
          </a>
        </span>
      </div>
      {src ? <iframe key={src} src={src} title={`Chat of ticket #${ticket?.id}`} allow="clipboard-read; clipboard-write; microphone"
        className="min-h-0 w-full flex-1 border-0 bg-background" />
        : <div className="flex flex-1 items-center justify-center p-6 text-sm">
          {error ? <p role="alert" className="max-w-md rounded-md bg-destructive-soft px-3 py-2 text-destructive">{error}</p>
            : <p role="status" className="inline-flex items-center gap-2 text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Opening the chat...</p>}
        </div>}
    </DialogContent>
  </Dialog>;
}
