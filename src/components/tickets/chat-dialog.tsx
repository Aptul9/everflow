'use client';

import { ExternalLink, PanelRightClose, PanelRightOpen, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatFile } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { ChatFrame, chatWebUrl, useChatFrame } from './chat-frame.tsx';
import type { OpenedChat } from './chat-frame.tsx';
import { FileViewer, useChatFiles } from './file-viewer.tsx';
import type { DescribeFile, ListFiles, ReadFile } from './file-viewer.tsx';

export type OpenChat = (ticket: number) => Promise<OpenedChat>;

export { BRIDGE_WAIT_MS } from './chat-frame.tsx';

const phone = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 639px)').matches;
const closeButton = 'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring';

// The ticket's chat managed from the board: the chat view framed through useChatFrame (chat-frame.tsx, shared with the
// Overview's client chat). Here the bridge's file clicks open the file in the panel beside the chat.
export function ChatDialog(props: { ticket: { id: number; title: string; session_id: string } | null; origin: string; open: OpenChat; files: ListFiles; file: ReadFile;
  describe: DescribeFile; onClose: () => void }) {
  const { ticket } = props;
  const { open, origin } = props;
  const id = ticket?.id, session = ticket?.session_id;

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

  // keyed on the ticket and session, not the card object: a board refresh must not reload a chat in use
  const chat = useChatFrame({ id: id !== undefined && session ? `${id}:${session}` : null, origin, open: () => open(id!), onClose: props.onClose,
    onOpenFile: (path) => { void openPath(path); } });
  const { ownClose } = chat;

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
          <a href={chatWebUrl(origin, session ?? '')} target="_blank" rel="noopener" aria-label={`Open the chat of ticket #${ticket?.id} in OpenChamber`}
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
          <ChatFrame chat={chat} title={`Chat of ticket #${ticket?.id}`} className="sm:rounded-lg" />
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
