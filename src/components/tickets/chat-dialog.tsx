'use client';

import { ExternalLink, LoaderCircle, PanelRightClose, PanelRightOpen, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/utils.ts';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { FileViewer, useChatFiles } from './file-viewer.tsx';
import type { ListFiles, ReadFile } from './file-viewer.tsx';

export type OpenChat = (ticket: number) => Promise<{ session_id: string; directory: string }>;

const hiddenKey = (session: string) => `everflow.chat-files.${session}`;
function storedHidden(session: string | undefined): boolean {
  try { return !!session && localStorage.getItem(hiddenKey(session)) === 'hidden'; } catch { return false; }
}

// The ticket's chat managed from the board: OpenChamber's own chat view (mini-chat.html: messages, context gauge, composer
// with model and agent) framed from the chat host, which carries the same sign-in. The server first resolves the folder
// OpenChamber keeps the session in and registers it, without which the view opens empty. Once the chat has written files,
// a viewer beside it shows them, since they live on the daemon's machine.
export function ChatDialog(props: { ticket: { id: number; title: string; session_id: string } | null; origin: string; open: OpenChat; files: ListFiles; file: ReadFile; onClose: () => void }) {
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

  const { files, now } = useChatFiles(id, session, props.files);
  const [selected, setSelected] = useState('');
  const [hidden, setHidden] = useState(() => storedHidden(session));
  const [tab, setTab] = useState<'chat' | 'file'>('chat');
  useEffect(() => { setHidden(storedHidden(session)); setTab('chat'); setSelected(''); }, [session]);
  // the newest file opens as soon as there is one, and again when the open one disappears
  useEffect(() => {
    if (files.length && !files.some((file) => file.path === selected)) setSelected(files[0]!.path);
  }, [files, selected]);
  const toggle = () => {
    const next = !hidden;
    setHidden(next);
    try { if (session) localStorage.setItem(hiddenKey(session), next ? 'hidden' : 'shown'); } catch { /* private mode: the choice lasts this page only */ }
  };
  const withFiles = files.length > 0 && id !== undefined, wide = withFiles && !hidden;

  const encoded = encodeURIComponent(session ?? '');
  return <Dialog open={!!ticket} onOpenChange={(next) => { if (!next) props.onClose(); }}>
    {/* The chat view already shows the session title, so the ticket title stays for screen readers only. Desktop: a column
        as wide as the chat needs (its messages and composer stop near 900 px) and as tall as the window less a small margin;
        with files, the chat keeps 800 px on the left and the viewer takes the rest. The links and Close sit in the chat's own
        header row, in the empty space left of its context gauge, pin and pop-out buttons (about 160 px from the right edge of
        the chat in OpenChamber 2.7.2). Phone: full screen, links in a slim strip on top, Chat and File as tabs. */}
    <DialogContent showCloseButton={false}
      className={cn('flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:h-[calc(100dvh-1.5rem)] sm:max-w-none sm:rounded-lg',
        wide ? 'sm:w-[min(1800px,98vw)]' : 'sm:w-[min(1100px,96vw)]')}>
      <DialogTitle className="sr-only"><span>#{ticket?.id}</span>{ticket?.title}</DialogTitle>
      <DialogDescription className="sr-only">Chat of this ticket in OpenChamber</DialogDescription>
      <div className={cn('flex shrink-0 justify-end border-b sm:pointer-events-none sm:absolute sm:top-2 sm:left-0 sm:z-10 sm:border-0 sm:pr-[176px]',
        wide ? 'sm:w-[min(800px,55%)]' : 'sm:w-full')}>
        <div className="flex items-center gap-1 px-2 py-1 text-xs sm:pointer-events-auto sm:rounded-md sm:bg-background sm:p-0">
          {withFiles && <button type="button" onClick={toggle} aria-pressed={!hidden} aria-label={hidden ? `Show the files of this chat (${files.length})` : 'Hide the files of this chat'}
            className="hidden items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:inline-flex">
            {hidden ? <PanelRightOpen aria-hidden="true" className="size-3.5" /> : <PanelRightClose aria-hidden="true" className="size-3.5" />}Files
          </button>}
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
      </div>
      {withFiles && <div role="tablist" aria-label="Chat or file" className="flex shrink-0 gap-1 border-b px-2 py-1 sm:hidden">
        {(['chat', 'file'] as const).map((name) => <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}
          className={cn('flex-1 rounded-md px-3 py-1.5 text-sm font-medium', tab === name ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
          {name === 'chat' ? 'Chat' : 'File'}
        </button>)}
      </div>}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', wide && 'sm:w-[min(800px,55%)] sm:flex-none', withFiles && tab === 'file' && 'max-sm:hidden')}>
          {src ? <iframe key={src} src={src} title={`Chat of ticket #${ticket?.id}`} allow="clipboard-read; clipboard-write; microphone"
            className="min-h-0 w-full flex-1 border-0 bg-background sm:rounded-lg" />
            : <div className="flex flex-1 items-center justify-center p-6 text-sm">
              {error ? <p role="alert" className="max-w-md rounded-md bg-destructive-soft px-3 py-2 text-destructive">{error}</p>
                : <p role="status" className="inline-flex items-center gap-2 text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Opening the chat...</p>}
            </div>}
        </div>
        {withFiles && <div className={cn('min-h-0 min-w-0 flex-1 sm:border-l', tab === 'chat' && 'max-sm:hidden', hidden && 'sm:hidden')}>
          <FileViewer ticket={id} files={files} selected={selected} onSelect={setSelected} read={props.file} now={now} />
        </div>}
      </div>
    </DialogContent>
  </Dialog>;
}
