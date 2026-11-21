import { ArrowRight } from 'lucide-react';
import type { ExplainerDiagram } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';

// Only drawings that show a relation: a sequence (flow), a containment (nest), several things resting on one (hub)
export function Diagram({ diagram, className }: { diagram: ExplainerDiagram; className?: string }) {
  const { i: items, t: type, hi } = diagram;
  if (items.length < 2 || !['flow', 'nest', 'hub'].includes(type) || type === 'hub' && !diagram.b) return null;
  const on = (index: number) => hi === index;
  const nested = (index: number): React.ReactNode => <div className={cn('min-w-0 rounded-lg border p-2', on(index) ? 'border-primary bg-accent' : 'bg-muted/60')}>
    <div className={cn('rounded px-2 py-1 text-sm font-semibold break-words', on(index) && 'bg-primary text-primary-foreground')}>{items[index]}</div>
    {index + 1 < items.length && <div className="mt-2">{nested(index + 1)}</div>}
  </div>;
  return <div role="img" aria-label={`Schema: ${items.join(', ')}${diagram.b ? `, ${diagram.b}` : ''}`} className={cn('@container min-w-0 w-full', className)}>
    {type === 'nest' ? nested(0) : type === 'hub' ? <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-center gap-2">{items.map((item, index) =>
        <div key={index} className={cn('min-w-0 rounded-lg border px-3 py-2 text-center text-sm font-medium leading-snug break-words', on(index) ? 'border-primary bg-primary text-primary-foreground' : 'bg-muted text-foreground')}>{item}</div>)}</div>
      <div className="rounded-lg bg-primary px-3 py-2 text-center text-sm font-semibold text-primary-foreground">{diagram.b}</div>
    </div> : <ol className="flex flex-col items-stretch gap-1 @lg:flex-row @lg:items-stretch">
      {items.map((item, index) => <li key={index} className="flex min-w-0 flex-col items-stretch gap-1 @lg:flex-1 @lg:flex-row @lg:items-center">
        {index > 0 && <ArrowRight aria-hidden="true" strokeWidth={2.5} className="size-5 shrink-0 self-center rotate-90 text-primary @lg:rotate-0" />}
        <div className={cn('flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-lg border px-2.5 py-2 text-sm leading-snug font-medium', on(index) ? 'border-primary bg-primary text-primary-foreground' : 'bg-muted text-foreground')}>
          <span aria-hidden="true" className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', on(index) ? 'bg-primary-foreground/20' : 'bg-background text-muted-foreground')}>{index + 1}</span>
          <span className="min-w-0 break-words">{item}</span>
        </div>
      </li>)}
    </ol>}
  </div>;
}
