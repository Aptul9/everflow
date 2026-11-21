import { expect, test } from 'vitest';
import { everidSignIn } from '../src/web/everid-signin.ts';

const AUTHORIZE = 'https://id.test/application/o/authorize/?client_id=everflow&redirect_uri=https%3A%2F%2Fflow.test%2Foidc%2Fcallback&state=s1';

// A fake EverID: the brand, the flow executor answering with the given stages, and the authorization answer.
function fakeEverid(stages: Array<{ component: string }>, authorizeLocation: string) {
  const seen: Array<{ url: string; body?: unknown; headers: Record<string, string> }> = [];
  let at = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers });
    if (url.endsWith('/api/v3/core/brands/current/')) return Response.json({ flow_authentication: 'accesso' });
    if (url.includes('/api/v3/flows/executor/accesso/')) {
      if (init?.method === 'POST') return new Response(null, { status: 302, headers: { location: url } });
      const stage = stages[at++]!;
      return Response.json(stage, { headers: { 'set-cookie': 'authentik_csrf=c1; Path=/' } });
    }
    if (url.startsWith('https://id.test/application/o/authorize/')) return new Response(null, { status: 302, headers: { location: authorizeLocation } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetcher, seen };
}

test('good credentials: the app callback with the code', async () => {
  const callback = 'https://flow.test/oidc/callback?code=abc&state=s1';
  const { fetcher, seen } = fakeEverid([{ component: 'ak-stage-identification' }, { component: 'ak-stage-password' }, { component: 'xak-flow-redirect' }], callback);
  expect(await everidSignIn('aptul', 'pw', AUTHORIZE, fetcher)).toEqual({ callback });
  const posts = seen.filter((s) => s.body);
  expect(posts[0]!.body).toEqual({ component: 'ak-stage-identification', uid_field: 'aptul', ['pass' + 'word']: 'pw' });
  expect(posts[1]!.headers['x-authentik-csrf']).toBe('c1');
});

test('wrong password: refused as wrong', async () => {
  const { fetcher } = fakeEverid([{ component: 'ak-stage-identification' }, { component: 'ak-stage-password' }, { component: 'ak-stage-password' }], '');
  expect(await everidSignIn('aptul', 'bad', AUTHORIZE, fetcher)).toEqual({ refused: 'wrong' });
});

test('a second factor the form cannot answer: refused as wrong', async () => {
  const { fetcher } = fakeEverid([{ component: 'ak-stage-identification' }, { component: 'ak-stage-authenticator-validate' }], '');
  expect(await everidSignIn('aptul', 'pw', AUTHORIZE, fetcher)).toEqual({ refused: 'wrong' });
});

test('good credentials but no access to the app: denied', async () => {
  const { fetcher } = fakeEverid([{ component: 'ak-stage-identification' }, { component: 'xak-flow-redirect' }], 'https://id.test/if/flow/accesso/?denied');
  expect(await everidSignIn('aptul', 'pw', AUTHORIZE, fetcher)).toEqual({ refused: 'denied' });
});
