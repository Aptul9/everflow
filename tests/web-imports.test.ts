import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import type { Node } from '@oxc-project/types';
import { expect, test } from 'vitest';
import { SCRATCH } from './support.ts';

function appEntries(root: string): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('App source link refused');
    if (entry.isDirectory()) entries.push(...appEntries(path));
    else if (/^(?:page|layout|route|default|template|loading|error|global-error|not-found|forbidden|unauthorized|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.(?:ts|tsx)$/.test(entry.name)) entries.push(path);
  }
  return entries;
}

test('new Next entries are discovered rather than depending on a hand-maintained seed list', () => {
  const root = mkdtempSync(join(SCRATCH, 'phase7-next-entry-'));
  mkdirSync(join(root, 'nested'), { recursive: true });
  writeFileSync(join(root, 'layout.tsx'), 'export default function Layout() {}');
  writeFileSync(join(root, 'nested', 'loading.tsx'), 'export default function Loading() {}');
  writeFileSync(join(root, 'nested', 'not-an-entry.ts'), 'export const helper = true;');
  expect(appEntries(root).sort()).toEqual([join(root, 'layout.tsx'), join(root, 'nested', 'loading.tsx')].sort());
});

function webGraph() {
  const paths = [
    'src/web/api.ts', 'src/web/state.ts', 'src/web/instance.ts', 'src/web/login.ts', 'src/lib/web-types.ts', 'src/lib/utils.ts',
    'src/app/login/page.tsx', 'src/components/login-form.tsx',
    'src/core/approval.ts', 'src/core/db.ts', 'src/core/jobs.ts', 'src/core/tickets.ts', 'src/core/time.ts', 'src/core/policy.ts', 'src/core/settings.ts', 'src/core/initiative-state.ts',
    'src/app/page.tsx', 'src/app/layout.tsx', 'src/app/globals.css', 'src/app/api/state/route.ts', 'src/app/api/ticket/[id]/route.ts', 'src/app/api/ticket/[id]/[action]/route.ts',
    'src/app/overview/page.tsx', 'src/app/api/initiatives/route.ts', 'src/app/api/initiatives/[action]/route.ts', 'src/components/initiatives/initiatives-page.tsx',
    'src/app/api/batch/[id]/ticket/route.ts', 'src/app/api/batch/[id]/mute/route.ts', 'src/app/api/batch/[id]/clear/route.ts', 'src/app/api/conversation/[id]/unmute/route.ts', 'src/app/api/input/route.ts', 'src/app/api/setting/route.ts', 'src/app/api/job/[id]/retry/route.ts',
    ...['action-dialog', 'chat-dialog', 'file-viewer', 'markdown', 'pipeline', 'ticket-board', 'ticket-card', 'use-overview'].map((name) => `src/components/tickets/${name}.${name === 'use-overview' ? 'ts' : 'tsx'}`),
    ...['alert', 'badge', 'button', 'card', 'checkbox', 'dialog', 'input', 'popover', 'scroll-area', 'separator', 'tabs', 'textarea'].map((name) => `src/components/ui/${name}.tsx`),
  ];
  const allowed = new Set(paths.map((path) => resolve(path)));
  const external = new Set(['node:crypto', 'node:fs', 'node:path', 'node:sqlite', 'next/headers', 'zod', 'react', 'radix-ui', 'lucide-react', 'clsx', 'tailwind-merge', 'class-variance-authority', 'react-markdown', 'remark-gfm']);
  const queue = appEntries(resolve('src/app'));
  for (const name of ['instrumentation', 'instrumentation-client', 'proxy', 'middleware']) {
    for (const ext of ['ts', 'tsx']) if (existsSync(resolve(`src/${name}.${ext}`))) queue.push(resolve(`src/${name}.${ext}`));
  }
  const visited = new Set<string>();
  while (queue.length) {
    const path = queue.pop()!;
    if (visited.has(path)) continue;
    expect(allowed.has(path), `Unapproved automatically loaded Next entry ${path}`).toBe(true);
    visited.add(path);
    if (path.endsWith('.css')) continue;
    const source = parseAst(readFileSync(path, 'utf8'), { lang: path.endsWith('.tsx') ? 'tsx' : 'ts' }, path);
    const walk = (node: Node) => {
      if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
        if (node.type === 'ImportDeclaration' ? node.importKind === 'type'
          || node.specifiers.length > 0 && node.specifiers.every((item) => item.type === 'ImportSpecifier' && item.importKind === 'type')
          : node.exportKind === 'type') return;
        if (node.source) {
          const name = node.source.value;
          if (name.startsWith('.') || name.startsWith('@/')) {
            const stem = name.startsWith('@/') ? resolve('src', name.slice(2)) : resolve(dirname(path), name);
            const target = [stem, `${stem}.ts`, `${stem}.tsx`].find((candidate) => allowed.has(candidate));
            expect(target, `Unapproved transitive web import ${name} in ${path}`).toBeDefined();
            queue.push(target!);
          } else expect(external.has(name), `Unapproved web dependency ${name}`).toBe(true);
        }
      }
      if (node.type === 'ImportExpression' || node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
        throw new Error(`Dynamic module edge in web source: ${path}`);
      }
      for (const value of Object.values(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
          if (child && typeof child === 'object' && 'type' in child) walk(child as Node);
        }
      }
    };
    walk(source);
  }
  expect([...visited].some((path) => /(?:config|vault|opencode|kb-agent|chat)\.ts$/.test(path))).toBe(false);
  return visited;
}

test('the transitive application web graph stays inside its explicit runtime source allowlist', () => {
  webGraph();
});

test('the automatically loaded root layout is covered by the transitive graph', () => {
  expect(webGraph().has(resolve('src/app/layout.tsx'))).toBe(true);
});
