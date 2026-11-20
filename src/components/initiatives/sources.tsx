'use client';

import { useState } from 'react';
import type { ExplainerSource, InitiativeSource } from '../../lib/web-types.ts';

type Cited = { id: string; date?: string; text: string };

// Server and browser must render the same timestamp, independent of their local time zones.
export function formatInitiativeTime(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}

// A small date chip; opening it shows the cited lines verbatim
function Chip({ items, label }: { items: Cited[]; label: string }) {
  const [open, setOpen] = useState(false);
  const newest = [...items].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')).at(-1)!;
  return <span className="ml-1 inline">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={`${label} (${items.length})`}
      className="rounded bg-muted px-1 font-mono text-[10px] whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-accent-foreground">
      {newest.date ? newest.date.slice(5) : newest.id}{items.length > 1 ? ` +${items.length - 1}` : ''}
    </button>
    {open && <span role="note" className="mt-1.5 block space-y-1.5 rounded-md border bg-background p-2.5 text-[12px] leading-snug whitespace-pre-wrap text-muted-foreground">
      {items.map((item) => <span key={item.id} className="block"><span className="mr-1 font-mono text-foreground/70">{item.id}</span>{item.text}</span>)}
    </span>}
  </span>;
}

export function Sources({ sources }: { sources: InitiativeSource[] }) {
  return sources.length ? <Chip items={sources} label="Sources" /> : null;
}

export function GuideSources({ ids, sources }: { ids: string[]; sources: Record<string, ExplainerSource> }) {
  const items = ids.map((id) => sources[id]).filter((item): item is ExplainerSource => !!item);
  return items.length ? <Chip items={items} label="Fonti" /> : null;
}
