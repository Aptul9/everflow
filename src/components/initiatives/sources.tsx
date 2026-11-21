'use client';

import { Info, Play } from 'lucide-react';
import { useState } from 'react';
import { cleanSourceText } from '../../lib/web-types.ts';
import type { ExplainerSource, InitiativeSource } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

type Cited = { id: string; date?: string; text: string; kind?: ExplainerSource['kind'] };

export function formatDate(value: string, long = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  if (!long) return `${match[3]}/${match[2]}/${match[1]}`;
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`));
}

export function formatInitiativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date).replace(', ', ' ');
}

// A row that shows only its title until clicked: blue triangle on the left, turned down when open
export function Fold(props: { title: React.ReactNode; preview?: React.ReactNode; open?: boolean; className?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!props.open);
  return <div data-fold="" data-open={open ? 'true' : undefined} className={props.className}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 text-left leading-snug">
      <Play aria-hidden="true" className={cn('mt-[0.2em] size-3 shrink-0 fill-primary text-primary transition-transform', open && 'rotate-90')} />
      <span className="min-w-0 flex-1">{props.title}{!open && props.preview}</span>
    </button>
    {open && <div className="mt-1.5 pl-5">{props.children}</div>}
  </div>;
}

const kindLabel = { log: 'Registro del progetto', section: 'Nota del progetto', note: 'Nota collegata', ticket: 'Ticket' } as const;

function SourceText({ text }: { text: string }) {
  return <>{text.split(/(`[^`\n]+`)/).map((part, index) => index % 2 ? <code key={index} className="font-mono text-[0.92em]">{part.slice(1, -1)}</code> : part)}</>;
}

function source(item: Cited) {
  const note = item.kind === 'note';
  const text = note ? item.text.replace(/^.*\//, '').replace(/\.md$/, '').replace(/[-_]+/g, ' ') : cleanSourceText(item.text);
  const label = item.kind ? kindLabel[item.kind] : item.text.startsWith('Ticket #') ? 'Ticket' : 'Registro del progetto';
  return { text, label };
}

function Chip({ items }: { items: Cited[] }) {
  return <Popover><PopoverTrigger asChild><button type="button" aria-label={`Fonti (${items.length})`} className="ml-1 inline-flex items-center gap-0.5 align-middle text-muted-foreground hover:text-primary">
    <Info aria-hidden="true" className="size-4" />{items.length > 1 && <span className="text-[10px]">{items.length}</span>}
  </button></PopoverTrigger><PopoverContent align="start" collisionPadding={8} className="w-[min(400px,calc(100vw-16px))] max-h-[min(60vh,480px)] overflow-y-auto p-3">
    <h3 className="mb-2 text-sm font-semibold">Fonti</h3>
    <div className="space-y-2.5">{items.map((item, index) => {
      const { text, label } = source(item);
      const head = <span className="block text-[12px] text-muted-foreground">{item.date ? `${formatDate(item.date)} · ` : ''}{label}</span>;
      return <Fold key={item.id} open={index === 0} className="text-[13px] leading-relaxed"
        title={head} preview={<span className="line-clamp-1">{text.replaceAll('`', '')}</span>}>
        <p className="whitespace-pre-wrap break-words"><SourceText text={text} /></p>
      </Fold>;
    })}</div>
  </PopoverContent></Popover>;
}

export function Sources({ sources }: { sources: InitiativeSource[] }) {
  return sources.length ? <Chip items={sources} /> : null;
}

export function GuideSources({ ids, sources }: { ids: string[]; sources: Record<string, ExplainerSource> }) {
  const items = ids.map((id) => sources[id]).filter((item): item is ExplainerSource => !!item);
  return items.length ? <Chip items={items} /> : null;
}
