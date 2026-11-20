'use client';

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ExplainerTerm } from '../../lib/web-types.ts';

type Alias = { alias: string; id: string; exact: boolean };
type Index = { re: RegExp; byKey: Map<string, Alias[]> };

function buildIndex(terms: ExplainerTerm[]): Index | null {
  const aliases: Alias[] = [];
  for (const term of terms) {
    for (const raw of [term.term, ...term.aliases]) {
      const alias = raw.trim();
      if (alias) aliases.push({ alias, id: term.id, exact: alias === alias.toUpperCase() && /\p{Lu}/u.test(alias) });
    }
  }
  if (!aliases.length) return null;
  aliases.sort((a, b) => b.alias.length - a.alias.length);
  const byKey = new Map<string, Alias[]>();
  for (const item of aliases) byKey.set(item.alias.toLowerCase(), [...byKey.get(item.alias.toLowerCase()) ?? [], item]);
  const escaped = aliases.map((item) => item.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return { re: new RegExp(`(?<![\\p{L}\\p{N}_\\-.])(${escaped.join('|')})(?![\\p{L}\\p{N}_\\-])`, 'giu'), byKey };
}

interface Gloss {
  index: Index | null;
  highlight: string | null;
  back: number | null;
  show: (id: string, element: HTMLElement, touch?: boolean) => void;
  hide: () => void;
  jump: (id: string) => void;
  goBack: () => void;
  tip: { id: string; touch: boolean } | null;
  pointer: { current: string };
}
const Context = createContext<Gloss | null>(null);

export function useGloss() { return useContext(Context); }

export function GlossProvider({ terms, children }: { terms: ExplainerTerm[]; children: ReactNode }) {
  const index = useMemo(() => buildIndex(terms), [terms]);
  const byId = useMemo(() => new Map(terms.map((term) => [term.id, term])), [terms]);
  const [tip, setTip] = useState<{ id: string; rect: DOMRect; touch: boolean } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [back, setBack] = useState<number | null>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const tipRef = useRef<HTMLDivElement>(null);
  const pointer = useRef('mouse');

  const show = useCallback((id: string, element: HTMLElement, touch = false) => setTip({ id, rect: element.getBoundingClientRect(), touch }), []);
  const hide = useCallback(() => setTip(null), []);
  const jump = useCallback((id: string) => {
    const target = document.getElementById(`g-${id}`);
    if (!target) return;
    setBack((previous) => previous ?? window.scrollY);
    setTip(null);
    setHighlight(id);
    target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => setHighlight((current) => current === id ? null : current), 2600);
  }, []);
  const goBack = useCallback(() => {
    if (back !== null) window.scrollTo?.({ top: back, behavior: 'smooth' });
    setBack(null);
  }, [back]);

  useLayoutEffect(() => {
    if (!tip || !tipRef.current) return;
    const width = tipRef.current.offsetWidth, height = tipRef.current.offsetHeight;
    const left = Math.min(Math.max(8, tip.rect.left), window.innerWidth - width - 8);
    let top = tip.rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, tip.rect.top - height - 8);
    setPos({ left, top });
  }, [tip]);

  useEffect(() => {
    if (!tip) return;
    const close = () => setTip(null);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setTip(null); };
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.gloss-term, [role="tooltip"]')) setTip(null);
    };
    window.addEventListener('scroll', close, { passive: true });
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('scroll', close); window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', outside); };
  }, [tip]);

  const value = useMemo<Gloss>(() => ({ index, highlight, back, show, hide, jump, goBack, tip: tip && { id: tip.id, touch: tip.touch }, pointer }),
    [index, highlight, back, show, hide, jump, goBack, tip]);
  const term = tip ? byId.get(tip.id) : undefined;
  return <Context.Provider value={value}>
    {children}
    {tip && term && <div ref={tipRef} role="tooltip" id="gloss-tip" style={{ position: 'fixed', left: pos.left, top: pos.top }}
      className={`z-50 w-72 max-w-[calc(100vw-16px)] rounded-lg border bg-popover p-3 text-sm leading-snug text-popover-foreground shadow-lg ${tip.touch ? '' : 'pointer-events-none'}`}>
      <b className="mb-0.5 block">{term.term}</b>{term.short}
      <span className="mt-1.5 block text-xs text-muted-foreground">
        {tip.touch ? <button type="button" onClick={() => jump(term.id)} className="font-medium text-primary underline underline-offset-2">Vai al glossario</button> : 'Clic per aprire il glossario'}
      </span>
    </div>}
    {back !== null && <button type="button" onClick={goBack}
      className="fixed bottom-4 left-4 z-40 rounded-full border bg-card px-4 py-2 text-sm font-medium shadow-lg hover:bg-accent">&#8617; Torna dove eri</button>}
  </Context.Provider>;
}

export function GlossBack() {
  const gloss = useGloss();
  if (gloss?.back == null) return null;
  return <button type="button" onClick={gloss.goBack} className="mt-1 text-xs font-medium text-primary hover:underline">&#8617; torna dove eri</button>;
}

function Term({ id, word, gloss }: { id: string; word: string; gloss: Gloss }) {
  const active = gloss.tip?.id === id;
  return <button type="button" className="gloss-term" aria-describedby={active ? 'gloss-tip' : undefined}
    onPointerDown={(event) => { gloss.pointer.current = event.pointerType; }}
    onMouseEnter={(event) => { if (gloss.pointer.current !== 'touch') gloss.show(id, event.currentTarget); }}
    onMouseLeave={() => { if (gloss.pointer.current !== 'touch') gloss.hide(); }}
    onFocus={(event) => {
      let visible = true;
      try { visible = event.currentTarget.matches(':focus-visible'); } catch { /* selector unsupported */ }
      if (visible && gloss.pointer.current !== 'touch') gloss.show(id, event.currentTarget);
    }}
    onBlur={() => { if (gloss.pointer.current !== 'touch') gloss.hide(); }}
    onClick={(event) => {
      if (gloss.pointer.current === 'touch' && !active) gloss.show(id, event.currentTarget, true);
      else gloss.jump(id);
    }}>{word}</button>;
}

// Text with every glossary term turned into a dotted link; code spans and the term's own entry are left alone
export function Glossed({ text, skip }: { text: string; skip?: string }) {
  const gloss = useGloss();
  if (!gloss) return <>{text}</>;
  const out: ReactNode[] = [];
  text.split(/(`[^`\n]+`)/).forEach((part, p) => {
    if (p % 2) { out.push(<code key={p} className="rounded bg-muted px-1 py-px font-mono text-[0.88em]">{part.slice(1, -1)}</code>); return; }
    let last = 0;
    if (gloss.index) {
      for (const match of part.matchAll(gloss.index.re)) {
        const hit = gloss.index.byKey.get(match[1]!.toLowerCase())?.find((item) => !item.exact || item.alias === match[1]);
        if (!hit || hit.id === skip) continue;
        out.push(part.slice(last, match.index));
        out.push(<Term key={`${p}-${match.index}`} id={hit.id} word={match[1]!} gloss={gloss} />);
        last = match.index + match[0].length;
      }
    }
    out.push(part.slice(last));
  });
  return <>{out}</>;
}
