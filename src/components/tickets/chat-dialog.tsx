'use client';

import { ExternalLink, LoaderCircle, PanelRightClose, PanelRightOpen, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatFile } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { FileViewer, useChatFiles } from './file-viewer.tsx';
import type { DescribeFile, ListFiles, ReadFile } from './file-viewer.tsx';

export type OpenChat = (ticket: number) => Promise<{ session_id: string; directory: string }>;

/** How long the chat view gets, once loaded, to say its bridge runs before the dialog shows its own Close again. */
export const BRIDGE_WAIT_MS = 6_000;

const phone = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 639px)').matches;
const closeButton = 'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring';

// The ticket's chat managed from the board: OpenChamber's own chat view (mini-chat.html: messages, context gauge, composer
// with model and agent) framed from the chat host, which carries the same sign-in. The server first resolves the folder
// OpenChamber keeps the session in and registers it, without which the view opens empty. The chat host adds Everflow's
// bridge to that view: a click on a file the chat names opens it in the panel beside the chat, and the view's pop-out
// button becomes the dialog's Close. Messages count only from that frame and the chat host's origin.
export function ChatDialog(props: { ticket: { id: number; title: string; session_id: string } | null; origin: string; open: OpenChat; files: ListFiles; file: ReadFile;
  describe: DescribeFile; onClose: () => void }) {
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

  // The files: those the chat wrote (polled), and those clicked in the chat this time the dialog is open. Open tabs are
  // their own state. The panel starts closed: the Files button opens it on the newest written file, a file clicked in the chat opens or focuses its tab.
  const { files: written, now } = useChatFiles(id, session, props.files);
  const [clicked, setClicked] = useState<ChatFile[]>([]);
  const files = [...written, ...clicked.filter((item) => !written.some((file) => file.path === item.path))];
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState('');
  const [hidden, setHidden] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [tree, setTree] = useState(false);
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'chat' | 'file'>('chat');
  const autoOpened = useRef(false);
  useEffect(() => {
    setHidden(true); setTab('chat'); setClicked([]); setTabs([]); setActive(''); setExpanded(false); setTree(false); setNotice('');
    autoOpened.current = false;
  }, [session]);
  useEffect(() => {
    if (autoOpened.current || !written.length) return;
    autoOpened.current = true;
    const newest = written[0]!.path;
    setTabs((current) => current.length ? current : [newest]);
    setActive((current) => current || newest);
  }, [written]);
  const remember = (next: boolean) => setHidden(next);
  const focus = (path: string) => {
    setTabs((current) => current.includes(path) ? current : [...current, path]);
    setActive(path);
  };
  const reveal = () => {
    if (hidden) remember(false);
    if (phone()) setTab('file');
  };
  const closeTab = (path: string) => {
    const at = tabs.indexOf(path), next = tabs.filter((item) => item !== path);
    setTabs(next);
    if (path === active) setActive(next[Math.min(at, next.length - 1)] ?? '');
  };

  // A file clicked in the chat: focused at once when it is open or listed under the same path, otherwise asked from the
  // server, which answers for any file the chat's history names and resolves a path relative to the session folder
  const { describe } = props;
  const openPath = async (path: string) => {
    if (id === undefined) return;
    reveal();
    setNotice('');
    if (files.some((file) => file.path === path)) { focus(path); return; }
    try {
      const file = await describe(id, path);
      setClicked((current) => [...current.filter((item) => item.path !== file.path), file]);
      focus(file.path);
    } catch (failure) { setNotice(`${path}: ${failure instanceof Error ? failure.message : 'file unavailable'}`); }
  };

  const frame = useRef<HTMLIFrameElement>(null);
  const [bridged, setBridged] = useState(false);
  const [late, setLate] = useState(false);
  const loaded = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { setBridged(false); setLate(false); return () => clearTimeout(loaded.current); }, [src]);
  const handlers = useRef({ open: openPath, close: props.onClose });
  handlers.current = { open: openPath, close: props.onClose };
  useEffect(() => {
    let expected: string;
    try { expected = new URL(origin).origin; } catch { return; }
    const listener = (event: MessageEvent) => {
      if (event.origin !== expected || !frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as { type?: unknown; path?: unknown } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'everflow:ready') setBridged(true);
      else if (data.type === 'everflow:close') handlers.current.close();
      else if (data.type === 'everflow:open-file' && typeof data.path === 'string' && data.path && data.path.length <= 4096) void handlers.current.open(data.path);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [origin]);
  const onLoad = () => {
    clearTimeout(loaded.current);
    loaded.current = setTimeout(() => setLate(true), BRIDGE_WAIT_MS);
  };
  // the chat view's own Close (the bridge) replaces the dialog's; without a chat view or a bridge, the dialog keeps one
  const ownClose = !src || late && !bridged;

  const withFiles = (files.length > 0 || tabs.length > 0 || !!notice) && id !== undefined, wide = withFiles && !hidden, full = wide && expanded;
  const encoded = encodeURIComponent(session ?? '');
  return <Dialog open={!!ticket} onOpenChange={(next) => { if (!next) props.onClose(); }}>
    {/* The chat view already shows the session title, so the ticket title stays for screen readers only. Desktop: a column
        as wide as the chat needs (its messages and composer stop near 900 px) and as tall as the window less a small margin;
        with files, the chat keeps 800 px on the left and the panel takes the rest, or all of it when expanded. The links sit
        in the chat's own header row, in the empty space left of its context gauge, pin and Close buttons (about 160 px from
        the right edge of the chat in OpenChamber 2.7.2). Phone: full screen, links in a slim strip on top, Chat and File as tabs. */}
    <DialogContent showCloseButton={false}
      className={cn('flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:h-[calc(100dvh-1.5rem)] sm:max-w-none sm:rounded-lg',
        wide ? 'sm:w-[min(1800px,98vw)]' : 'sm:w-[min(1100px,96vw)]')}>
      <DialogTitle className="sr-only"><span>#{ticket?.id}</span>{ticket?.title}</DialogTitle>
      <DialogDescription className="sr-only">Chat of this ticket in OpenChamber</DialogDescription>
      <div className={cn('flex shrink-0 justify-end border-b sm:pointer-events-none sm:absolute sm:top-2 sm:left-0 sm:z-10 sm:border-0 sm:pr-[176px]',
        wide ? 'sm:w-[min(800px,55%)]' : 'sm:w-full', full && 'sm:hidden')}>
        <div className="flex items-center gap-1 px-2 py-1 text-xs sm:pointer-events-auto sm:rounded-md sm:bg-background sm:p-0">
          {withFiles && <button type="button" onClick={() => remember(!hidden)} aria-pressed={!hidden} aria-label={hidden ? `Show the files of this chat (${files.length})` : 'Hide the files of this chat'}
            className="hidden items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:inline-flex">
            {hidden ? <PanelRightOpen aria-hidden="true" className="size-3.5" /> : <PanelRightClose aria-hidden="true" className="size-3.5" />}Files
          </button>}
          <a href={`openchamber://session/${encoded}`} aria-label={`Open the chat of ticket #${ticket?.id} in the OpenChamber app`}
            className="rounded px-2 py-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">App</a>
          <a href={`${origin}/?session=${encoded}`} target="_blank" rel="noopener" aria-label={`Open the chat of ticket #${ticket?.id} in OpenChamber`}
            className="inline-flex items-center gap-1 rounded px-2 py-1 font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            OpenChamber<ExternalLink aria-hidden="true" className="size-3" />
          </a>
          {ownClose && <DialogClose aria-label="Close" className={cn('ml-1', closeButton)}><XIcon aria-hidden="true" className="size-4" /></DialogClose>}
        </div>
      </div>
      {withFiles && <div role="tablist" aria-label="Chat or file" className="flex shrink-0 gap-1 border-b px-2 py-1 sm:hidden">
        {(['chat', 'file'] as const).map((name) => <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}
          className={cn('flex-1 rounded-md px-3 py-1.5 text-sm font-medium', tab === name ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
          {name === 'chat' ? 'Chat' : 'File'}
        </button>)}
      </div>}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', wide && !full && 'sm:w-[min(800px,55%)] sm:flex-none', full && 'sm:hidden', withFiles && tab === 'file' && 'max-sm:hidden')}>
          {src ? <iframe ref={frame} key={src} src={src} title={`Chat of ticket #${ticket?.id}`} allow="clipboard-read; clipboard-write; microphone" onLoad={onLoad}
            className="min-h-0 w-full flex-1 border-0 bg-background sm:rounded-lg" />
            : <div className="flex flex-1 items-center justify-center p-6 text-sm">
              {error ? <p role="alert" className="max-w-md rounded-md bg-destructive-soft px-3 py-2 text-destructive">{error}</p>
                : <p role="status" className="inline-flex items-center gap-2 text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Opening the chat...</p>}
            </div>}
        </div>
        {withFiles && <div className={cn('min-h-0 min-w-0 flex-1 sm:border-l', full && 'sm:border-l-0', tab === 'chat' && 'max-sm:hidden', hidden && 'sm:hidden')}>
          <FileViewer ticket={id} files={files} tabs={tabs} active={active} now={now} read={props.file} onOpen={focus} onCloseTab={closeTab}
            tree={tree} onToggleTree={() => setTree((value) => !value)} expanded={full} onToggleExpand={() => setExpanded((value) => !value)}
            onClosePanel={() => { remember(true); setExpanded(false); setTab('chat'); }} notice={notice} onDismissNotice={() => setNotice('')}
            // the chat (and its Close) is hidden when the panel is expanded, and on a phone's File tab
            extra={<DialogClose aria-label="Close the chat" title="Close" className={cn(closeButton, 'size-8', !full && 'sm:hidden')}><XIcon aria-hidden="true" className="size-4" /></DialogClose>} />
        </div>}
      </div>
    </DialogContent>
  </Dialog>;
}
