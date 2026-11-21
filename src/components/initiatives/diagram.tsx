import { ChevronRight } from 'lucide-react';
import type { ExplainerDiagram } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';

export function Diagram({ diagram, className }: { diagram: ExplainerDiagram; className?: string }) {
  const { i: items, t: type, hi } = diagram;
  if (items.length < 2 || !['flow', 'nest', 'split', 'hub', 'row'].includes(type)) return null;
  const box = (index: number) => cn('min-w-0 rounded-lg border px-3 py-2 text-center text-sm font-medium leading-snug break-words', hi === index ? 'border-primary bg-primary text-primary-foreground' : 'bg-muted text-foreground');
  const nested = (index: number): React.ReactNode => <div className={cn('min-w-0 rounded-lg border p-2', hi === index ? 'border-primary bg-accent' : 'bg-muted')}>
    <div className={cn('rounded px-2 py-1 text-sm font-semibold break-words', hi === index && 'bg-primary text-primary-foreground')}>{items[index]}</div>
    {index + 1 < items.length && <div className="mt-2">{nested(index + 1)}</div>}
  </div>;
  return <div role="img" aria-label={`Schema: ${items.join(', ')}${diagram.b ? `, ${diagram.b}` : ''}`} className={cn('min-w-0 w-full', className)}>
    {type === 'nest' ? nested(0) : type === 'hub' ? <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-center gap-2">{items.map((item, index) => <div key={index} className={box(index)}>{item}</div>)}</div>
      {diagram.b && <div className="rounded-lg bg-primary px-3 py-2 text-center text-sm font-semibold text-primary-foreground">{diagram.b}</div>}
    </div> : <div className={cn('gap-2', type === 'split' ? 'grid grid-cols-2 items-start' : type === 'flow' ? 'flex flex-col items-stretch sm:flex-row sm:flex-wrap sm:items-center' : 'flex flex-wrap items-center')}>
      {items.map((item, index) => <div key={index} className={cn('flex min-w-0 items-center gap-2', type === 'split' && 'contents', type === 'flow' && 'flex-col sm:flex-row')}>
        {type === 'flow' && index > 0 && <ChevronRight aria-hidden="true" className="size-4 shrink-0 rotate-90 text-muted-foreground sm:rotate-0" />}
        <div className={cn(box(index), type === 'row' && 'rounded-full')}>{item}</div>
      </div>)}
    </div>}
  </div>;
}
