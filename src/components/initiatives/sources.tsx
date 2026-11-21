'use client';

import { Info } from 'lucide-react';
import { useState } from 'react';
import type { ExplainerSource, InitiativeSource } from '../../lib/web-types.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

type Cited = { id: string; date?: string; text: string };

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

function SourceLine({ item }: { item: Cited }) {
  const [expanded, setExpanded] = useState(false);
  const text = item.text.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+-\s+/, '');
  return <div className="min-w-0 text-[13px] leading-relaxed">
    {item.date && <div className="font-medium text-muted-foreground">{formatDate(item.date)}</div>}
    <div className={expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-6 whitespace-pre-wrap break-words'}>{text.split(/(`[^`\n]+`)/).map((part, index) => index % 2 ? <code key={index} className="font-mono">{part.slice(1, -1)}</code> : part)}</div>
    {(text.length > 200 || text.split('\n').length > 6) && <button type="button" className="mt-1 text-xs font-medium text-primary hover:underline" onClick={() => setExpanded(!expanded)}>{expanded ? 'Mostra meno' : 'Mostra tutto'}</button>}
  </div>;
}

function Chip({ items }: { items: Cited[] }) {
  return <Popover><PopoverTrigger asChild><button type="button" aria-label={`Fonti (${items.length})`} className="ml-1 inline-flex items-center gap-0.5 align-middle text-muted-foreground hover:text-primary">
    <Info aria-hidden="true" className="size-4" />{items.length > 1 && <span className="text-[10px]">{items.length}</span>}
  </button></PopoverTrigger><PopoverContent align="start" className="w-[min(380px,calc(100vw-16px))] max-h-[min(60vh,480px)] space-y-3 overflow-y-auto p-3">
    <h3 className="text-sm font-semibold">Fonti</h3>{items.map((item) => <SourceLine key={item.id} item={item} />)}
  </PopoverContent></Popover>;
}

export function Sources({ sources }: { sources: InitiativeSource[] }) {
  return sources.length ? <Chip items={sources} /> : null;
}

export function GuideSources({ ids, sources }: { ids: string[]; sources: Record<string, ExplainerSource> }) {
  const items = ids.map((id) => sources[id]).filter((item): item is ExplainerSource => !!item);
  return items.length ? <Chip items={items} /> : null;
}
