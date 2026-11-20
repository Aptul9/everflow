import { useId } from 'react';
import type { ReactNode } from 'react';
import type { ExplainerDiagram } from '../../lib/web-types.ts';
import { cn } from '../../lib/utils.ts';

const W = 240;

function wrap(text: string, max: number): string[] {
  const lines = [''];
  for (const word of text.split(' ')) {
    const current = lines[lines.length - 1]!;
    if (`${current} ${word}`.trim().length > max && current) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`.trim();
  }
  return lines;
}

function Label(props: { x: number; y: number; text: string; on?: boolean; max: number; size: number }) {
  const lines = wrap(props.text, props.max), step = props.size + 3, top = props.y - (lines.length - 1) * step / 2;
  return <>{lines.map((line, index) => <text key={index} x={props.x} y={top + index * step} textAnchor="middle" dominantBaseline="middle"
    fontSize={props.size} fontWeight={600} fill={props.on ? 'var(--primary-foreground)' : 'var(--foreground)'}>{line}</text>)}</>;
}

function Box(props: { x: number; y: number; w: number; h: number; on?: boolean; alt?: boolean }) {
  return <rect x={props.x} y={props.y} width={props.w} height={props.h} rx={8} strokeWidth={1.5}
    fill={props.on ? 'var(--primary)' : props.alt ? 'var(--accent)' : 'var(--muted)'} stroke={props.on ? 'var(--primary)' : 'var(--input)'} />;
}

// A small teaching drawing: boxes and arrows laid out by the diagram kind
export function Diagram({ diagram, className }: { diagram: ExplainerDiagram; className?: string }) {
  const marker = `arrow${useId().replace(/\W/g, '')}`;
  const items = diagram.i, count = items.length;
  if (!count) return null;
  const arrow = (x1: number, y1: number, x2: number, y2: number) =>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--muted-foreground)" strokeWidth={2} markerEnd={`url(#${marker})`} />;
  let height = 110;
  let body: ReactNode;
  if (diagram.t === 'nest') {
    height = 30 + count * 30;
    body = items.map((text, k) => {
      const pad = k * 14;
      return <g key={k}>
        <rect x={pad} y={pad} width={W - 2 * pad} height={height - 2 * pad} rx={8} strokeWidth={1.5}
          fill={diagram.hi === k ? 'var(--primary)' : k % 2 ? 'var(--accent)' : 'var(--muted)'} stroke={diagram.hi === k ? 'var(--primary)' : 'var(--input)'} />
        <text x={pad + 10} y={pad + 19} fontSize={12} fontWeight={700} fill={diagram.hi === k ? 'var(--primary-foreground)' : 'var(--foreground)'}>{text}</text>
      </g>;
    });
  } else if (diagram.t === 'split') {
    const bw = (W - 10 * (count - 1)) / count;
    body = items.map((text, k) => <g key={k}><Box x={k * (bw + 10)} y={20} w={bw} h={70} on={diagram.hi === k} />
      <Label x={k * (bw + 10) + bw / 2} y={55} text={text} on={diagram.hi === k} max={count > 2 ? 9 : 13} size={12} /></g>);
  } else if (diagram.t === 'one') {
    body = <g><Box x={10} y={15} w={W - 20} h={80} on />
      <text x={W / 2} y={items[1] ? 47 : 56} textAnchor="middle" dominantBaseline="middle" fontSize={15} fontWeight={700} fill="var(--primary-foreground)">{items[0]}</text>
      {items[1] && <text x={W / 2} y={72} textAnchor="middle" fontSize={12} fill="var(--primary-foreground)" opacity={0.85}>{items[1]}</text>}</g>;
  } else if (diagram.t === 'hub') {
    height = 140;
    const bw = (W - 10 * (count - 1)) / count;
    body = <g>{items.map((text, k) => <g key={k}><Box x={k * (bw + 10)} y={5} w={bw} h={42} />
      <Label x={k * (bw + 10) + bw / 2} y={26} text={text} max={count > 2 ? 9 : 14} size={11} />{arrow(k * (bw + 10) + bw / 2, 49, k * (bw + 10) + bw / 2, 90)}</g>)}
      <Box x={0} y={95} w={W} h={42} on /><Label x={W / 2} y={116} text={diagram.b ?? ''} on max={30} size={13} /></g>;
  } else {
    const flow = diagram.t === 'flow', gap = flow ? 14 : 6, bw = (W - gap * (count - 1)) / count;
    body = items.map((text, k) => {
      const x = k * (bw + gap);
      return <g key={k}><Box x={x} y={25} w={bw} h={60} on={diagram.hi === k} />
        <Label x={x + bw / 2} y={55} text={text} on={diagram.hi === k} max={count > 3 ? 7 : 10} size={count > 3 ? 10 : 11} />
        {flow && k < count - 1 && arrow(x + bw + 1, 55, x + bw + gap - 2, 55)}</g>;
    });
  }
  return <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Schema: ${items.join(', ')}`} className={cn('w-full', className)}>
    <defs><marker id={marker} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="var(--muted-foreground)" /></marker></defs>
    {body}
  </svg>;
}
