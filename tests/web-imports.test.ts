import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import type { Node } from '@oxc-project/types';
import { expect, test } from 'vitest';

test('the transitive application web graph stays inside its explicit runtime source allowlist', () => {
  const paths = [
    'src/web/api.ts', 'src/web/state.ts', 'src/web/instance.ts', 'src/lib/web-types.ts', 'src/lib/utils.ts',
    'src/dispatcher/approval.ts', 'src/dispatcher/db.ts', 'src/dispatcher/jobs.ts', 'src/dispatcher/tickets.ts', 'src/dispatcher/time.ts', 'src/dispatcher/policy.ts',
    'src/app/page.tsx', 'src/app/api/state/route.ts', 'src/app/api/ticket/[id]/route.ts', 'src/app/api/ticket/[id]/[action]/route.ts',
    'src/app/api/batch/[id]/ticket/route.ts', 'src/app/api/job/[id]/retry/route.ts',
    ...['action-dialog', 'ticket-board', 'ticket-card', 'use-overview'].map((name) => `src/components/tickets/${name}.${name === 'use-overview' ? 'ts' : 'tsx'}`),
    ...['alert', 'badge', 'button', 'card', 'checkbox', 'dialog', 'input', 'scroll-area', 'separator', 'tabs', 'textarea'].map((name) => `src/components/ui/${name}.tsx`),
  ];
  const allowed = new Set(paths.map((path) => resolve(path)));
  const external = new Set(['node:crypto', 'node:fs', 'node:path', 'node:sqlite', 'zod', 'react', 'radix-ui', 'lucide-react', 'clsx', 'tailwind-merge', 'class-variance-authority']);
  const queue = paths.filter((path) => path.startsWith('src/app/')).map((path) => resolve(path));
  const visited = new Set<string>();
  while (queue.length) {
    const path = queue.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
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
});
