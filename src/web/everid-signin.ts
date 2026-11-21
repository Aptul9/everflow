// The app's own sign-in form, checked by EverID behind it: the server signs in to EverID's authentication flow with the
// typed credentials (its own cookie jar, gone after the request), then runs the app's authorization request with that
// session. The browser never sees EverID: the answer is EverID's redirect to the app callback, finished server-side.

export type SignIn = { callback: string } | { refused: 'wrong' | 'denied' };

const TIMEOUT_MS = 10_000;

export async function everidSignIn(username: string, password: string, authorizeUrl: string, fetcher: typeof fetch = fetch): Promise<SignIn> {
  const origin = new URL(authorizeUrl).origin;
  const redirectUri = new URL(authorizeUrl).searchParams.get('redirect_uri') ?? '';
  const jar = new Map<string, string>();

  async function send(url: string, body?: unknown): Promise<Response> {
    let method = body === undefined ? 'GET' : 'POST';
    let payload = body === undefined ? undefined : JSON.stringify(body);
    for (let hop = 0; hop < 5; hop += 1) {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (payload !== undefined) headers['content-type'] = 'application/json';
      if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const csrf = jar.get('authentik_csrf');
      if (csrf) headers['x-authentik-csrf'] = csrf;
      const response = await fetcher(url, { method, headers, ...(payload === undefined ? {} : { body: payload }), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(';', 1)[0] ?? '', at = pair.indexOf('=');
        if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
      const location = response.headers.get('location');
      // the flow executor answers a submitted stage with a redirect to itself; anything else is returned as it is
      if (response.status >= 300 && response.status < 400 && location && new URL(location, url).pathname.startsWith('/api/v3/flows/executor/')) {
        url = new URL(location, url).href; method = 'GET'; payload = undefined;
        continue;
      }
      return response;
    }
    throw new Error('everid.redirects');
  }

  const brand = await send(`${origin}/api/v3/core/brands/current/`);
  if (!brand.ok) throw new Error(`everid.brand ${brand.status}`);
  const flow = ((await brand.json()) as { flow_authentication?: string }).flow_authentication || 'default-authentication-flow';
  const executor = `${origin}/api/v3/flows/executor/${encodeURIComponent(flow)}/?query=`;
  let step = (await (await send(executor)).json()) as { component?: string };
  let identified = false, sent = false;
  for (let i = 0; i < 4 && step.component !== 'xak-flow-redirect'; i += 1) {
    let answer: Record<string, string>;
    if (step.component === 'ak-stage-identification' && !identified) {
      identified = true;
      answer = { component: step.component, uid_field: username, password };
    } else if (step.component === 'ak-stage-password' && !sent) {
      sent = true;
      answer = { component: step.component, password };
    } else {
      return { refused: 'wrong' };
    }
    step = (await (await send(executor, answer)).json()) as { component?: string };
  }
  if (step.component !== 'xak-flow-redirect') return { refused: 'wrong' };
  const authorized = await send(authorizeUrl);
  const location = authorized.headers.get('location') ?? '';
  if (redirectUri && location.startsWith(`${redirectUri}?`) && new URL(location).searchParams.has('code')) return { callback: location };
  return { refused: 'denied' };
}
