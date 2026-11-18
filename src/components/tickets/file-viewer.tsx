'use client';

import { Download, FileText, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatFile } from '../../lib/web-types.ts';
import { age, formatTime } from './ticket-card.tsx';

export type ListFiles = (ticket: number, signal?: AbortSignal) => Promise<ChatFile[]>;
export type ReadFile = (ticket: number, path: string, download: boolean, signal?: AbortSignal) => Promise<Response>;

export const FILES_POLL_MS = 10_000;

/** The files the ticket's chat wrote, asked again every 10 seconds while the chat is open. */
export function useChatFiles(ticket: number | undefined, session: string | undefined, list: ListFiles) {
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setFiles([]);
    if (ticket === undefined || !session) return;
    const controller = new AbortController();
    // a failed listing keeps the last one: the viewer is an aid, the chat stays usable without it
    const load = () => { void list(ticket, controller.signal).then((next) => { if (!controller.signal.aborted) { setFiles(Array.isArray(next) ? next : []); setNow(Date.now()); } }, () => {}); };
    load();
    const timer = setInterval(load, FILES_POLL_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [ticket, session, list]);
  return { files, now };
}

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

type View = { state: 'loading' } | { state: 'error'; message: string } | { state: 'download' }
  | { state: 'markdown' | 'text'; text: string } | { state: 'html'; html: string } | { state: 'pdf' | 'image'; url: string };

// Bytes become a blob: URL of a type chosen here, never a page address: the page host refuses to be framed
function useView(ticket: number, file: ChatFile | undefined, read: ReadFile, reload: number): View {
  const [view, setView] = useState<View>({ state: 'loading' });
  const shown = useRef<string | undefined>(undefined);
  const path = file?.path, kind = file?.kind, mtime = file?.mtime;
  useEffect(() => {
    if (!path || !kind) return;
    // another file starts from a spinner; the same file changed on disk stays on screen until the new content is in
    if (shown.current !== path) setView({ state: 'loading' });
    shown.current = path;
    if (kind === 'other') { setView({ state: 'download' }); return; }
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      const response = await read(ticket, path, false, controller.signal);
      if (kind === 'pdf' || kind === 'image') {
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(new Blob([bytes], { type: kind === 'pdf' ? 'application/pdf' : response.headers.get('content-type') ?? 'image/png' }));
        setView({ state: kind, url });
        return;
      }
      const text = await response.text();
      if (!controller.signal.aborted) setView(kind === 'docx' ? { state: 'html', html: text } : { state: kind, text });
    })().catch((failure: unknown) => { if (!controller.signal.aborted) setView({ state: 'error', message: failure instanceof Error ? failure.message : 'File unavailable' }); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [ticket, path, kind, mtime, read, reload]);
  return view;
}

// Vault notes open with YAML front matter, which Markdown would read as a heading: it shows as a small block on top
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function MarkdownFile({ text }: { text: string }) {
  const front = FRONT_MATTER.exec(text);
  return <article className="file-doc px-5 py-4">
    {front && <pre aria-label="Front matter" className="file-meta">{front[1]}</pre>}
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
      components={{ a: ({ node: _node, ...link }) => <a {...link} target="_blank" rel="noopener noreferrer" /> }}>{front ? text.slice(front[0].length) : text}</ReactMarkdown>
  </article>;
}

export function FileViewer(props: { ticket: number; files: ChatFile[]; selected: string; onSelect: (path: string) => void; read: ReadFile; now: number }) {
  const file = props.files.find((candidate) => candidate.path === props.selected) ?? props.files[0];
  const [reload, setReload] = useState(0);
  const [failure, setFailure] = useState('');
  const view = useView(props.ticket, file, props.read, reload);
  const download = async () => {
    if (!file) return;
    setFailure('');
    try {
      const blob = await (await props.read(props.ticket, file.path, true)).blob();
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setFailure(error instanceof Error ? error.message : 'Download failed'); }
  };
  if (!file) return null;
  return <section aria-label="Files of this chat" className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
      <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <select aria-label="File" value={file.path} title={file.path} onChange={(event) => props.onSelect(event.target.value)}
        className="h-8 min-w-0 flex-1 truncate rounded-md border border-input bg-background px-2 text-sm">
        {props.files.map((item) => <option key={item.path} value={item.path} title={item.path}>{`${item.name} · ${age(props.now, item.touched)} ago`}</option>)}
      </select>
      <button type="button" aria-label={`Download ${file.name}`} title="Download" onClick={() => { void download(); }}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <Download aria-hidden="true" className="size-4" />
      </button>
      <button type="button" aria-label="Reload the file" title="Reload" onClick={() => setReload((value) => value + 1)}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <RefreshCw aria-hidden="true" className="size-4" />
      </button>
    </div>
    <p className="shrink-0 truncate border-b px-3 py-1 text-xs text-muted-foreground" title={file.path}>
      {file.path} · {size(file.size)} · changed <time dateTime={file.mtime} suppressHydrationWarning>{formatTime(file.mtime)}</time>
    </p>
    {failure && <p role="alert" className="mx-3 mt-2 rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{failure}</p>}
    <div className="min-h-0 flex-1 overflow-auto">
      {view.state === 'loading' ? <p role="status" className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Opening {file.name}...</p>
        : view.state === 'error' ? <p role="alert" className="m-3 rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{view.message}</p>
          : view.state === 'download' ? <p className="p-4 text-sm text-muted-foreground">This file type has no preview here: use Download.</p>
            : view.state === 'markdown' ? <MarkdownFile text={view.text} />
              : view.state === 'text' ? <pre className="m-0 p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">{view.text}</pre>
                // sanitized by the server: no scripts, no event handlers, images only as data: URIs
                : view.state === 'html' ? <article className="file-doc px-5 py-4" dangerouslySetInnerHTML={{ __html: view.html }} />
                  : view.state === 'pdf' ? <iframe src={view.url} title={file.name} className="size-full border-0" />
                    : view.state === 'image' ? <img src={view.url} alt={file.name} className="mx-auto block max-w-full p-4" /> : null}
    </div>
  </section>;
}
