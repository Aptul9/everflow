'use client';

import { Fragment } from 'react';
import { cn } from '../../lib/utils.ts';

// Light Markdown for AI-written ticket text: **bold**, *italic*, `code`, [links](https://...), lists and paragraphs.
// Builds React elements only, never HTML, because the text derives from third-party messages.
const token = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\s][^*\n]*\*)/g;

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function Inline({ text }: { text: string }) {
  return <>{text.split(token).map((part, index) => {
    if (index % 2 === 0) return <Fragment key={index}>{part}</Fragment>;
    if (part.startsWith('**')) return <strong key={index} className="font-semibold">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={index} className="rounded bg-muted px-1 py-px font-mono text-[0.9em]">{part.slice(1, -1)}</code>;
    if (part.startsWith('[')) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)!;
      const url = safeUrl(href!);
      return url ? <a key={index} href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">{label}</a>
        : <Fragment key={index}>{label}</Fragment>;
    }
    return <em key={index}>{part.slice(1, -1)}</em>;
  })}</>;
}

type Block = { kind: 'p' | 'ul' | 'ol'; lines: string[] };
const bullet = /^\s*[-*]\s+/, numbered = /^\s*\d+[.)]\s+/;

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^#{1,6}\s+/, '');
    const kind = bullet.test(line) ? 'ul' : numbered.test(line) ? 'ol' : line.trim() ? 'p' : null;
    if (kind === null) { blocks.push({ kind: 'p', lines: [] }); continue; }
    const last = blocks.at(-1);
    const content = kind === 'p' ? line : line.replace(kind === 'ul' ? bullet : numbered, '');
    if (last && last.kind === kind && last.lines.length) last.lines.push(content);
    else blocks.push({ kind, lines: [content] });
  }
  return <div className={cn('space-y-1.5', className)}>
    {blocks.filter((block) => block.lines.length).map((block, index) => block.kind === 'p'
      ? <p key={index}>{block.lines.map((line, at) => <Fragment key={at}>{at > 0 && <br />}<Inline text={line} /></Fragment>)}</p>
      : block.kind === 'ul'
        ? <ul key={index} className="list-disc space-y-0.5 pl-5">{block.lines.map((line, at) => <li key={at}><Inline text={line} /></li>)}</ul>
        : <ol key={index} className="list-decimal space-y-0.5 pl-5">{block.lines.map((line, at) => <li key={at}><Inline text={line} /></li>)}</ol>)}
  </div>;
}
