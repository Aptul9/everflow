import { guideItemKey, italianDates, stripNoise } from '../lib/web-types.ts';
import type { Explainer } from '../lib/web-types.ts';

export type GuideExplanation = Pick<Explainer, 'title' | 'one_liner' | 'why' | 'role' | 'teams' | 'people' | 'concepts' | 'glossary' | 'warnings' | 'ask_who'>;
export type GuideStatus = Pick<Explainer, 'phases' | 'timeline' | 'goal' | 'graph' | 'blocked_by' | 'next_you'>;

// watched: the client's messages reach Everflow by themselves; hidden: next steps Antonio removed; flagged: texts he marked as wrong
export interface LintContext { watched: boolean; hidden: ReadonlySet<string>; flagged: ReadonlySet<string> }
// issues left after the pass: on the first answer they go back to the model, on the second they fail the run
export interface LintResult<T> { value: T; fixed: number; issues: string[]; dropped: string[]; checked: number }

const EN = new Set('the and is are was were to of with for on that this it be has have not will from by an at which who should would can its their they we you been but or if into than then there these those'.split(' '));
const IT = new Set('il lo la gli le di del della dei delle degli e è che per con un una uno non al alla ai alle nel nella nei sono ha hanno si come più ma anche da dal dalla su sul sulla tra fra questo questa quello quella cui chi dove quando se perché poi già ogni'.split(' '));
const ADMIN = /\b(?:report|rapporto|resoconto|riepilogo)\s+settimanal|\bweekly\s+report|\btimesheet|\bfattur|\bferie\b|\bnota\s+spese|\brapportino/i;
const CHECK = /\b(?:controll|ricontroll|verific|attend|aspett|guard|monitor)\w*\b[^.]{0,60}?\b(?:rispost|messagg|chat|e-?mail|replic)/i;

// A sentence written in English: quoted words and code are left out, the rest is counted against common Italian words
export function english(text: string): boolean {
  const words = text.replace(/`[^`]*`|«[^»]*»|"[^"]*"|“[^”]*”/g, ' ').toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 5) return false;
  let en = 0, it = 0;
  for (const word of words) { if (EN.has(word)) en++; else if (IT.has(word)) it++; }
  return en >= 2 && en > it * 2;
}

class Pass {
  fixed = 0; checked = 0; issues: string[] = []; dropped: string[] = [];
  constructor(readonly ctx: LintContext, readonly final: boolean) {}

  // Dates and machine noise are fixed in place; English and texts Antonio flagged are problems
  text(value: string, path: string, problems: string[] | null, language = true): string {
    const out = italianDates(stripNoise(value));
    if (out !== value) this.fixed++;
    if (problems && language && english(out)) problems.push(`${path}: è in inglese, va scritto in italiano`);
    if (problems && out && this.ctx.flagged.has(guideItemKey(out))) problems.push(`${path}: Antonio ha segnalato questo testo come sbagliato, riscrivilo`);
    return out;
  }

  scalar(value: string, path: string): string {
    const problems: string[] = [];
    const out = this.text(value, path, problems);
    this.checked++;
    this.issues.push(...problems);
    return out;
  }

  // An item with a problem goes back to the model on the first answer and is dropped on the second
  list<T>(items: T[], path: string, label: (item: T) => string, each: (item: T, at: string, problems: string[]) => T | null): T[] {
    return items.flatMap((item, index) => {
      this.checked++;
      const problems: string[] = [];
      const out = each(item, `${path}[${index}]`, problems);
      if (!out) return [];
      if (!problems.length) return [out];
      if (this.final) { this.dropped.push(`${label(out).slice(0, 120)}: ${problems.map((problem) => problem.slice(problem.indexOf(': ') + 2)).join('; ')}`); return []; }
      this.issues.push(...problems);
      return [out];
    });
  }

  result<T>(value: T): LintResult<T> { return { value, fixed: this.fixed, issues: this.issues, dropped: this.dropped, checked: this.checked }; }
}

const labels = (pass: Pass, items: string[]) => items.map((item) => pass.text(item, '', null));

// People and teams are cleaned but never dropped: the rest of the guide hangs on their ids
export function lintExplanation(value: GuideExplanation, ctx: LintContext, final: boolean): LintResult<GuideExplanation> {
  const pass = new Pass(ctx, final);
  const out: GuideExplanation = {
    title: pass.scalar(value.title, 'title'),
    one_liner: pass.scalar(value.one_liner, 'one_liner'),
    why: pass.list(value.why, 'why', (item) => item, (item, at, problems) => pass.text(item, at, problems)),
    role: pass.scalar(value.role, 'role'),
    teams: value.teams.map((team) => ({ ...team, plain: pass.text(team.plain, '', null) })),
    people: value.people.map((person) => ({ ...person, role: pass.text(person.role, '', null), plain: pass.text(person.plain, '', null),
      ask_for: pass.text(person.ask_for, '', null), how: pass.text(person.how, '', null) })),
    concepts: pass.list(value.concepts, 'concepts', (item) => item.title, (concept, at, problems) => ({ ...concept,
      title: pass.text(concept.title, `${at}.title`, problems, false), plain: pass.text(concept.plain, `${at}.plain`, problems),
      analogy: pass.text(concept.analogy, `${at}.analogy`, problems), say: pass.text(concept.say, `${at}.say`, problems),
      diagram: concept.diagram && { ...concept.diagram, i: labels(pass, concept.diagram.i) } })),
    glossary: pass.list(value.glossary, 'glossary', (item) => item.term, (term, at, problems) => ({ ...term,
      short: pass.text(term.short, `${at}.short`, problems), long: pass.text(term.long, `${at}.long`, problems),
      diagram: term.diagram && { ...term.diagram, i: labels(pass, term.diagram.i) } })),
    warnings: pass.list(value.warnings, 'warnings', (item) => item.title, (warning, at, problems) => ({ ...warning,
      title: pass.text(warning.title, `${at}.title`, problems, false), text: pass.text(warning.text, `${at}.text`, problems) })),
    ask_who: pass.list(value.ask_who, 'ask_who', (item) => item.need, (row, at, problems) => ({ ...row,
      need: pass.text(row.need, `${at}.need`, problems), how: pass.text(row.how, '', null) })),
  };
  return pass.result(out);
}

export function lintStatus(value: GuideStatus, ctx: LintContext, final: boolean): LintResult<GuideStatus> {
  const pass = new Pass(ctx, final);
  const phases = pass.list(value.phases, 'phases', (item) => item.title, (phase, at, problems) => {
    const items = pass.list(phase.items, `${at}.items`, (item) => item.title, (item, path, inner) => ({ ...item,
      title: pass.text(item.title, `${path}.title`, inner, false), note: pass.text(item.note, `${path}.note`, inner) }));
    return items.length ? { ...phase, title: pass.text(phase.title, `${at}.title`, problems, false), plain: pass.text(phase.plain, `${at}.plain`, problems), items } : null;
  });
  const nodes = pass.list(value.graph.nodes, 'graph.nodes', (item) => item.label, (node, at, problems) => ({ ...node,
    label: pass.text(node.label, `${at}.label`, problems, false), plain: pass.text(node.plain, `${at}.plain`, problems) }));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = pass.list(value.graph.edges.filter((edge) => (edge.kind === 'owes' || ids.has(edge.from)) && (ids.has(edge.to) || edge.to === 'goal')),
    'graph.edges', (item) => `${item.from} > ${item.to}`, (edge, at, problems) => ({ ...edge, why: pass.text(edge.why, `${at}.why`, problems) }));
  const out: GuideStatus = {
    phases,
    timeline: pass.list(value.timeline, 'timeline', (item) => item.title, (entry, at, problems) => ({ ...entry,
      title: pass.text(entry.title, `${at}.title`, problems, false), plain: pass.text(entry.plain, `${at}.plain`, problems) })),
    goal: { label: pass.scalar(value.goal.label, 'goal.label'), plain: pass.scalar(value.goal.plain, 'goal.plain') },
    graph: { nodes, edges },
    blocked_by: pass.list(value.blocked_by, 'blocked_by', (item) => item.title, (item, at, problems) => ({ ...item,
      title: pass.text(item.title, `${at}.title`, problems, false), plain: pass.text(item.plain, `${at}.plain`, problems),
      node: item.node && ids.has(item.node) ? item.node : null })),
    next_you: pass.list(value.next_you, 'next_you', (item) => item.text, (item, at, problems) => {
      if (ctx.hidden.has(guideItemKey(item.text))) { pass.dropped.push(`${item.text.slice(0, 120)}: già nascosto da Antonio`); return null; }
      const text = pass.text(item.text, `${at}.text`, problems), why = pass.text(item.why, `${at}.why`, problems);
      if (ADMIN.test(`${text} ${why}`)) problems.push(`${at}: è un'attività amministrativa verso l'azienda di Antonio, non un passo del progetto`);
      if (ctx.watched && CHECK.test(text)) problems.push(`${at}: chiede di controllare risposte o messaggi, ma Everflow li riceve già da solo`);
      return { ...item, text, why };
    }),
  };
  return pass.result(out);
}
