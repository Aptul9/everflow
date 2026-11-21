'use client';

import { Check, ChevronDown, ChevronUp, Copy, Download, Eye, FileText, FolderTree, ListTree, LoaderCircle, Maximize2, Minimize2, PanelRightClose, RefreshCw, Search, XIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatFile } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { age, formatTime } from './ticket-card.tsx';

const DocumentPreview = lazy(() => import('./document-preview.tsx').then((module) => ({ default: module.DocumentPreview })));

export type ListFiles = (ticket: number, signal?: AbortSignal) => Promise<ChatFile[]>;
export type ReadFile = (ticket: number, path: string, download: boolean, signal?: AbortSignal) => Promise<Response>;
export type DescribeFile = (ticket: number, path: string) => Promise<ChatFile>;

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
  | { state: 'markdown' | 'text'; text: string } | { state: 'image'; url: string }
  | { state: 'document'; kind: 'pdf' | 'docx' | 'pptx' | 'odt' | 'odp' | 'workbook'; bytes: ArrayBuffer };

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
      if (kind === 'image') {
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(new Blob([bytes], { type: response.headers.get('content-type') ?? 'image/png' }));
        setView({ state: kind, url });
        return;
      }
      if (kind === 'markdown' || kind === 'text') {
        const text = await response.text();
        if (!controller.signal.aborted) setView({ state: kind, text });
      } else {
        const bytes = await response.arrayBuffer();
        if (!controller.signal.aborted) setView({ state: 'document', kind, bytes });
      }
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

/** The file as written, one numbered line per row; the numbers stay out of find. */
function SourceFile({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  return <pre aria-label="Source" className="m-0 py-3 font-mono text-[13px] leading-relaxed">
    {lines.map((line, index) => <div key={index} className="flex">
      <span data-find-skip aria-hidden="true" className="w-12 shrink-0 pr-3 text-right text-muted-foreground/70 select-none">{index + 1}</span>
      <span className="min-w-0 flex-1 pr-4 break-all whitespace-pre-wrap">{line || ' '}</span>
    </div>)}
  </pre>;
}

// Find in file: matches are painted with the CSS highlight API, so the rendered document is never rewritten under React
const FIND = 'everflow-find', CURRENT = 'everflow-find-current';
type Registry = { set(name: string, value: unknown): void; delete(name: string): void };
type HighlightClass = new (...ranges: Range[]) => unknown;
function painter(): { registry: Registry; Highlight: HighlightClass } | null {
  const registry = (globalThis.CSS as unknown as { highlights?: Registry } | undefined)?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: HighlightClass }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

export function textRanges(root: Node, query: string): Range[] {
  const needle = query.toLowerCase(), ranges: Range[] = [];
  if (!needle) return ranges;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT,
    { acceptNode: (node) => node.parentElement?.closest('[data-find-skip]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase();
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

function useFind(root: RefObject<HTMLElement | null>, query: string, view: View, source: boolean, path: string | undefined) {
  const ranges = useRef<Range[]>([]);
  const [found, setFound] = useState({ count: 0, generation: 0 });
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const refresh = () => {
      ranges.current = root.current && query ? textRanges(root.current, query) : [];
      setFound((last) => ({ count: ranges.current.length, generation: last.generation + 1 }));
      setIndex(0);
    };
    refresh();
    if (!root.current || !query || view.state !== 'document' || view.kind !== 'workbook') return;
    const watcher = new MutationObserver(refresh);
    watcher.observe(root.current, { subtree: true, childList: true, characterData: true });
    return () => watcher.disconnect();
  }, [root, query, view, source, path]);
  useEffect(() => {
    const api = painter(), all = ranges.current, current = all[Math.min(index, all.length - 1)];
    if (api) {
      if (all.length) api.registry.set(FIND, new api.Highlight(...all)); else api.registry.delete(FIND);
      if (current) api.registry.set(CURRENT, new api.Highlight(current)); else api.registry.delete(CURRENT);
    }
    current?.startContainer.parentElement?.scrollIntoView?.({ block: 'center' });
  }, [found, index]);
  useEffect(() => () => { const api = painter(); api?.registry.delete(FIND); api?.registry.delete(CURRENT); }, []);
  const step = (by: number) => setIndex((value) => found.count ? (value + by + found.count) % found.count : 0);
  return { count: found.count, index, step };
}

const HEADINGS = 'h1, h2, h3, h4, h5, h6';
const iconButton = 'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-accent aria-pressed:text-foreground disabled:opacity-40';

// The file panel beside the chat, as OpenChamber's own: open files as tabs (a file opens once and is focused again when
// clicked again), a file list to open more, expand over the chat, close; per file: copy the path, preview or source,
// find with every match marked, the outline of its headings, download and reload.
export function FileViewer(props: {
  ticket: number; files: ChatFile[]; tabs: string[]; active: string; now: number; read: ReadFile;
  onOpen: (path: string) => void; onCloseTab: (path: string) => void;
  tree: boolean; onToggleTree: () => void; expanded: boolean; onToggleExpand: () => void; onClosePanel: () => void;
  notice?: string | undefined; onDismissNotice?: () => void; extra?: ReactNode;
}) {
  const byPath = new Map(props.files.map((file) => [file.path, file]));
  const tabs = props.tabs.flatMap((path) => byPath.get(path) ?? []);
  const file = tabs.find((candidate) => candidate.path === props.active) ?? tabs.at(-1);
  const [reload, setReload] = useState(0);
  const [failure, setFailure] = useState('');
  const [source, setSource] = useState(false);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outline, setOutline] = useState<{ level: number; text: string }[]>([]);
  const [copied, setCopied] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const view = useView(props.ticket, file, props.read, reload);
  const textual = view.state === 'markdown' || view.state === 'text';
  const canFind = textual || view.state === 'document' && view.kind === 'workbook';
  const showSource = source && textual;
  const find = useFind(body, finding ? query : '', view, showSource, file?.path);
  useEffect(() => {
    setOutline(body.current && !showSource ? [...body.current.querySelectorAll(HEADINGS)].map((heading) => ({ level: Number(heading.tagName[1]), text: heading.textContent ?? '' })) : []);
  }, [view, showSource, file?.path]);
  useEffect(() => { setOutlineOpen(false); setFailure(''); }, [file?.path]);
  useEffect(() => { if (finding) findInput.current?.focus(); }, [finding]);
  const tree = props.tree || !file;

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
  const copy = async () => {
    if (!file) return;
    try { await navigator.clipboard.writeText(file.path); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setFailure('The path could not be copied'); }
  };
  const keys = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && canFind) { event.preventDefault(); setFinding(true); findInput.current?.select(); }
  };
  const findKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); find.step(event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFinding(false); }
  };
  const goTo = (index: number) => {
    body.current?.querySelectorAll(HEADINGS)[index]?.scrollIntoView?.({ block: 'start' });
    setOutlineOpen(false);
  };

  return <section aria-label="Files of this chat" className="flex h-full min-h-0 flex-col" onKeyDown={keys}>
    <div className="flex shrink-0 items-center gap-1 border-b px-1.5 py-1">
      <div role="tablist" aria-label="Open files" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const selected = tab.path === file?.path;
          return <div key={tab.path} className={cn('group flex max-w-56 shrink-0 items-center rounded-md text-sm', selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-accent/60')}>
            <button type="button" role="tab" aria-selected={selected} title={tab.path} onClick={() => props.onOpen(tab.path)}
              className="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-2 focus-visible:outline-2 focus-visible:outline-ring">
              <FileText aria-hidden="true" className="size-3.5 shrink-0" /><span className="truncate">{tab.name}</span>
            </button>
            <button type="button" aria-label={`Close ${tab.name}`} title="Close" onClick={() => props.onCloseTab(tab.path)}
              className="mr-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </div>;
        })}
      </div>
      <button type="button" aria-label="Toggle file tree" title="Toggle file tree" aria-pressed={tree} onClick={props.onToggleTree} className={iconButton}>
        <FolderTree aria-hidden="true" className="size-4" />
      </button>
      <button type="button" aria-label={props.expanded ? 'Collapse panel' : 'Expand panel'} title={props.expanded ? 'Collapse panel' : 'Expand panel'} onClick={props.onToggleExpand}
        className={cn(iconButton, 'max-sm:hidden')}>
        {props.expanded ? <Minimize2 aria-hidden="true" className="size-4" /> : <Maximize2 aria-hidden="true" className="size-4" />}
      </button>
      <button type="button" aria-label="Close panel" title="Close panel" onClick={props.onClosePanel} className={iconButton}>
        <PanelRightClose aria-hidden="true" className="size-4" />
      </button>
      {props.extra}
    </div>
    {props.notice && <p role="alert" className="mx-3 mt-2 flex items-start gap-2 rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">
      <span className="min-w-0 flex-1 break-words">{props.notice}</span>
      {props.onDismissNotice && <button type="button" aria-label="Dismiss" onClick={props.onDismissNotice} className="shrink-0 rounded hover:bg-destructive/10"><XIcon aria-hidden="true" className="size-4" /></button>}
    </p>}
    <div className="flex min-h-0 flex-1">
      {tree && <nav aria-label="File list" className={cn('min-h-0 shrink-0 overflow-y-auto py-1', file ? 'w-48 border-r sm:w-60' : 'flex-1')}>
        {props.files.length ? <ul>
          {props.files.map((item) => <li key={item.path}>
            <button type="button" title={item.path} aria-current={item.path === file?.path ? 'true' : undefined} onClick={() => props.onOpen(item.path)}
              className="flex w-full min-w-0 items-baseline gap-2 px-3 py-1 text-left text-sm hover:bg-accent aria-[current=true]:bg-muted aria-[current=true]:font-medium">
              <span className="min-w-0 truncate">{item.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{age(props.now, item.touched)}</span>
            </button>
          </li>)}
        </ul> : <p className="px-3 py-2 text-sm text-muted-foreground">No files yet.</p>}
      </nav>}
      {file && <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-0.5 border-b px-2 py-1">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={file.path}>
            {file.path} · {size(file.size)} · changed <time dateTime={file.mtime} suppressHydrationWarning>{formatTime(file.mtime)}</time>
          </p>
          <button type="button" aria-label="Copy file path" title="Copy file path" onClick={() => { void copy(); }} className={iconButton}>
            {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
          </button>
          {textual && <button type="button" aria-label="Preview" title={source ? 'Show preview' : 'Show source'} aria-pressed={!source} onClick={() => setSource((value) => !value)} className={iconButton}>
            <Eye aria-hidden="true" className="size-4" />
          </button>}
          <button type="button" aria-label="Find in file" title="Find in file" aria-pressed={finding} disabled={!canFind}
            onClick={() => setFinding((value) => !value)} className={iconButton}>
            <Search aria-hidden="true" className="size-4" />
          </button>
          {outline.length > 0 && <div className="relative">
            <button type="button" aria-label="Outline" title="Outline" aria-expanded={outlineOpen} onClick={() => setOutlineOpen((value) => !value)} className={iconButton}>
              <ListTree aria-hidden="true" className="size-4" />
            </button>
            {outlineOpen && <nav aria-label="Outline of the file" className="absolute top-9 right-0 z-20 max-h-80 w-72 overflow-y-auto rounded-md border bg-popover py-1 shadow-md">
              <ul>{outline.map((heading, index) => <li key={index}>
                <button type="button" onClick={() => goTo(index)} style={{ paddingLeft: `${0.75 + (heading.level - 1) * 0.75}rem` }}
                  className="block w-full truncate py-1 pr-3 text-left text-sm hover:bg-accent">{heading.text}</button>
              </li>)}</ul>
            </nav>}
          </div>}
          <button type="button" aria-label={`Download ${file.name}`} title="Download" onClick={() => { void download(); }} className={iconButton}>
            <Download aria-hidden="true" className="size-4" />
          </button>
          <button type="button" aria-label="Reload the file" title="Reload" onClick={() => setReload((value) => value + 1)} className={iconButton}>
            <RefreshCw aria-hidden="true" className="size-4" />
          </button>
        </div>
        {finding && canFind && <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <input ref={findInput} type="search" aria-label="Find in file" placeholder="Find in file" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={findKeys}
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm" />
          <span role="status" aria-label="Matches" className="w-14 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{find.count ? `${find.index + 1}/${find.count}` : query ? '0/0' : ''}</span>
          <button type="button" aria-label="Previous match" disabled={!find.count} onClick={() => find.step(-1)} className={iconButton}><ChevronUp aria-hidden="true" className="size-4" /></button>
          <button type="button" aria-label="Next match" disabled={!find.count} onClick={() => find.step(1)} className={iconButton}><ChevronDown aria-hidden="true" className="size-4" /></button>
          <button type="button" aria-label="Close find" onClick={() => setFinding(false)} className={iconButton}><XIcon aria-hidden="true" className="size-4" /></button>
        </div>}
        {failure && <p role="alert" className="mx-3 mt-2 rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{failure}</p>}
        <div ref={body} className="min-h-0 flex-1 overflow-auto">
          {view.state === 'loading' ? <p role="status" className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Opening {file.name}...</p>
            : view.state === 'error' ? <p role="alert" className="m-3 rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{view.message}</p>
              : view.state === 'download' ? <p className="p-4 text-sm text-muted-foreground">This file type has no preview here: use Download.</p>
                : showSource ? <SourceFile text={view.text} />
                  : view.state === 'markdown' ? <MarkdownFile text={view.text} />
                    : view.state === 'text' ? <pre className="m-0 p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">{view.text}</pre>
                      : view.state === 'document' ? <Suspense fallback={<p role="status" className="p-4">Preparing preview…</p>}>
                        <DocumentPreview key={`${file.path}:${file.mtime}:${reload}`} kind={view.kind} bytes={view.bytes} name={file.name} />
                      </Suspense>
                          : view.state === 'image' ? <img src={view.url} alt={file.name} className="mx-auto block max-w-full p-4" /> : null}
        </div>
      </div>}
    </div>
  </section>;
}
