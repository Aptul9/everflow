import { expect, test } from 'vitest';
import { english, lintExplanation, lintStatus } from '../src/core/guide-lint.ts';
import type { GuideExplanation, GuideStatus, LintContext } from '../src/core/guide-lint.ts';
import { cleanSourceText, guideItemKey } from '../src/lib/web-types.ts';

// Every case here is a kind of slop that once reached a published guide

const ctx = (extra: Partial<LintContext> = {}): LintContext => ({ watched: true, hidden: new Set(), flagged: new Set(), ...extra });

function explanation(extra: Partial<GuideExplanation> = {}): GuideExplanation {
  return {
    title: 'Accessi di Acme', one_liner: 'Si mettono in regola gli accessi privilegiati di Acme.', why: ['Acme non ha ancora un catalogo degli accessi.'], role: 'Antonio raccoglie i fatti.',
    teams: [{ id: 'acme', name: 'Acme', plain: 'Il cliente.', kind: 'client', people: ['alice'] }],
    people: [{ id: 'alice', name: 'Alice Rossi', short: 'Alice', team: 'acme', role: 'Platform team lead', plain: 'Guida la piattaforma.', ask_for: 'Design', how: 'Teams', src: ['L1'] }],
    concepts: [{ id: 'c1', title: 'La chiave di scorta', plain: 'Un account usato solo quando niente altro funziona.', analogy: 'Una chiave in busta sigillata.', say: '', diagram: null, src: ['L1'] }],
    glossary: [{ id: 'vault', term: 'Vault', aliases: [], short: 'Cassaforte dei segreti.', long: '', diagram: null, icon: 'vault', general: true, src: [] }],
    warnings: [], ask_who: [], ...extra,
  };
}

function status(extra: Partial<GuideStatus> = {}): GuideStatus {
  return {
    phases: [{ id: 'p1', title: 'Mappatura', plain: 'Si censiscono gli accessi.', items: [{ title: 'Catalogo', status: 'doing', note: 'Versione 2 inviata.', src: ['L1'] }] }],
    timeline: [], goal: { label: 'Accessi in regola', plain: 'Ogni accesso ha un responsabile.' },
    graph: {
      nodes: [{ id: 'n1', kind: 'answer', label: 'Risposta di Alice', plain: 'Alice deve dire chi gestisce il secondo cluster.', status: 'open', owner: 'alice', since: '2026-11-11', src: ['L1'] },
        { id: 'n2', kind: 'task', label: 'Alert', plain: 'Serve un alert sul percorso dei segreti.', status: 'open', owner: 'you', since: null, src: ['L1'] }],
      edges: [{ from: 'alice', to: 'n1', kind: 'owes', why: 'Le domande sono passate a lei.', src: ['L1'] }, { from: 'n1', to: 'n2', kind: 'unblocks', why: 'Serve sapere chi legge il percorso.', src: ['L1'] },
        { from: 'n2', to: 'goal', kind: 'unblocks', why: 'Chiude il problema.', src: ['L1'] }],
    },
    blocked_by: [{ title: 'Risposta di Alice', plain: 'Senza risposta il ticket resta fermo.', who: 'alice', since: '2026-11-11', node: 'n2', src: ['L1'] }],
    next_you: [{ text: 'Chiedi per iscritto ad Alice chi gestisce il secondo cluster.', why: 'Lo sprint parte lunedì.', src: ['L1'] }], ...extra,
  };
}

test('dates written month first or ISO are rewritten day first, without touching ids or code', () => {
  const result = lintStatus(status({ next_you: [{ text: 'Rispondi alle domande del 11-05 entro il 2026-11-24.', why: 'Bloccato dal 11-19, vedi `2026-01-02` e OMP-855.', src: ['L1'] }] }), ctx(), false);
  expect(result.issues).toEqual([]);
  expect(result.value.next_you[0]).toMatchObject({ text: 'Rispondi alle domande del 05/11 entro il 24/11/2026.', why: 'Bloccato dal 19/11, vedi `2026-01-02` e OMP-855.' });
  expect(result.fixed).toBe(2);
});

test('Teams thread ids, staff ids, local paths and note file names never reach the text', () => {
  const result = lintExplanation(explanation({ why: ['Nella chat 19:meeting_QUJD@thread.v2, Alice (IN22898516) ha confermato; vedi tesco-demo.md e `C:/Users/x/Downloads/t.txt`.'] }), ctx(), false);
  expect(result.value.why[0]).toMatch(/^Nella Alice ha confermato; vedi e\.$/);
  for (const bad of ['@thread', 'IN22898516', '.md', 'Downloads']) expect(result.value.why[0]).not.toContain(bad);
  expect(cleanSourceText('2026-11-11 - Meeting chat `19:meeting_QUJD@thread.v2`, Duncan AGREED')).toBe('Duncan AGREED');
});

test('an English sentence in an Italian field goes back to the model, then is dropped', () => {
  const concepts = [...explanation().concepts, { id: 'c2', title: 'Break-glass', plain: 'Enterprise break-glass is the spare key used when nothing else works.', analogy: '', say: '', diagram: null, src: ['L1'] }];
  const first = lintExplanation(explanation({ concepts }), ctx(), false);
  expect(first.issues).toEqual(['concepts[1].plain: è in inglese, va scritto in italiano']);
  const second = lintExplanation(explanation({ concepts }), ctx(), true);
  expect(second.issues).toEqual([]);
  expect(second.value.concepts.map((concept) => concept.id)).toEqual(['c1']);
  expect(second.dropped).toEqual(['Break-glass: è in inglese, va scritto in italiano']);
  expect(english('Il job lo mette in un kubeconfig e lo carica in un safe CyberArk.')).toBe(false);
  expect(english('Basha ha detto «we need to verify your identity before you get the key».')).toBe(false);
});

test('an English one-liner cannot be dropped, so it stays an issue on the second answer too', () => {
  const result = lintExplanation(explanation({ one_liner: 'We map and fix the privileged access to the platform.' }), ctx(), true);
  expect(result.issues).toEqual(['one_liner: è in inglese, va scritto in italiano']);
});

test('next steps about Antonio\'s own company, or checking replies the relay already brings, are refused', () => {
  const next_you = [
    { text: 'Inviare il report settimanale per la propria azienda.', why: 'Non risulta inviato.', src: ['L1'] },
    { text: 'Controllare la risposta di Alice ai messaggi di oggi.', why: 'Sono partite 4 domande.', src: ['L1'] },
    ...status().next_you,
  ];
  const watched = lintStatus(status({ next_you }), ctx(), true);
  expect(watched.value.next_you.map((item) => item.text)).toEqual([status().next_you[0]!.text]);
  expect(watched.dropped).toHaveLength(2);
  const unwatched = lintStatus(status({ next_you }), ctx({ watched: false }), true);
  expect(unwatched.value.next_you.map((item) => item.text)).toEqual([next_you[1]!.text, next_you[2]!.text]);
});

test('a next step Antonio hid does not come back, a text he flagged is a problem', () => {
  const hidden = lintStatus(status(), ctx({ hidden: new Set([guideItemKey(status().next_you[0]!.text)]) }), false);
  expect(hidden.value.next_you).toEqual([]);
  expect(hidden.issues).toEqual([]);
  const flagged = lintExplanation(explanation(), ctx({ flagged: new Set([guideItemKey('Una chiave in busta sigillata.')]) }), false);
  expect(flagged.issues).toEqual(['concepts[0].analogy: Antonio ha segnalato questo testo come sbagliato, riscrivilo']);
});

test('dropping a node also drops its edges and the blocker link to it', () => {
  const graph = status().graph;
  graph.nodes[1]!.plain = 'The alert should fire when somebody reads the path.';
  const result = lintStatus(status({ graph }), ctx(), true);
  expect(result.value.graph.nodes.map((node) => node.id)).toEqual(['n1']);
  expect(result.value.graph.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(['alice>n1']);
  expect(result.value.blocked_by[0]!.node).toBeNull();
});
