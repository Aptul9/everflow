import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Sign-in through EverID (OpenID Connect, authorization code + PKCE, confidential client). The code is exchanged server to
// server with the issuer's token endpoint over TLS, so the ID token is taken from that response without checking its
// signature (OIDC Core 3.1.3.7, item 6); issuer, audience, expiry and nonce are still checked. Everflow has one account and EverID
// decides who may hold it: an account in app-flow whose `sub` is listed, or a member of everid-admins with the account's email.
// EverID never verifies an email (no mail server), so an email alone is trusted only from an account an admin manages.
export const OIDC_COOKIE = 'everflow_oidc';
export const HINT_COOKIE = 'everflow_idt';
export const START_PATH = '/oidc/start';
export const CALLBACK_PATH = '/oidc/callback';
export const OIDC_GROUP = 'app-flow';
export const ADMIN_GROUP = 'everid-admins';
export const FLOW_MS = 10 * 60 * 1000;
const DISCOVERY_MS = 60 * 60 * 1000;
const b64 = (bytes: Buffer) => bytes.toString('base64url');

export interface OidcSettings {
  issuer: string; clientId: string; clientSecret: string; redirectUri: string; postLogoutUri: string; email: string; group: string;
  adminGroup: string; subjects: string[];
}
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string; end_session_endpoint?: string }
export interface Flow { state: string; nonce: string; verifier: string; next: string; expires: number }

// Plain errors with a code: the sign-in page maps the everid.* codes to its message
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const ISSUER = /^(?:https:\/\/[a-z0-9.-]+(?::\d{1,5})?|http:\/\/127\.0\.0\.1:\d{1,5})\/[^\s?#]*$/i;
// a compact JWT small enough for a cookie
export const ID_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const ID_TOKEN_MAX = 3500;
const sameIssuer = (a: string, b: string) => a.replace(/\/$/, '') === b.replace(/\/$/, '');

/** EverID client from OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET; undefined when none is set, an error when only some are. */
export function oidcSettings(publicOrigin: string | undefined, email: string, env: Record<string, string | undefined> = process.env,
  subjects: string[] = []): OidcSettings | undefined {
  const issuer = env.OIDC_ISSUER?.trim() ?? '', clientId = env.OIDC_CLIENT_ID?.trim() ?? '', clientSecret = env.OIDC_CLIENT_SECRET?.trim() ?? '';
  if (!issuer && !clientId && !clientSecret) return undefined;
  if (!issuer || !clientId || !clientSecret) throw failure('oidc.client-required', 'oidc.client-required: OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET go together');
  // loopback http only for a local issuer under test; anything reachable goes over TLS
  if (!ISSUER.test(issuer)) throw failure('oidc.issuer', 'oidc.issuer: OIDC_ISSUER must be an https address with a path');
  if (!publicOrigin) throw failure('oidc.public-origin', 'oidc.public-origin: EverID sign-in needs [web] public_origin');
  return { issuer, clientId, clientSecret, redirectUri: publicOrigin + CALLBACK_PATH, postLogoutUri: publicOrigin + '/',
    email: email.trim().toLowerCase(), group: OIDC_GROUP, adminGroup: ADMIN_GROUP, subjects: [...subjects] };
}

const flowMac = (key: Buffer, body: string) => b64(createHmac('sha256', key).update('everflow oidc flow v1\0' + body).digest());

/** The pending sign-in, signed with the login key, for the short-lived cookie between start and callback. */
export function sealFlow(key: Buffer, flow: Flow): string {
  const body = b64(Buffer.from(JSON.stringify(flow)));
  return `${body}.${flowMac(key, body)}`;
}

export function openFlow(key: Buffer, value: string | undefined, now = Date.now()): Flow | undefined {
  const match = /^([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
  if (!match) return undefined;
  const expected = Buffer.from(flowMac(key, match[1]!)), supplied = Buffer.from(match[2]!);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  let flow: Partial<Flow>;
  try { flow = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as Partial<Flow>; } catch { return undefined; }
  if (typeof flow.state !== 'string' || typeof flow.nonce !== 'string' || typeof flow.verifier !== 'string' || typeof flow.next !== 'string'
    || typeof flow.expires !== 'number' || flow.expires <= now) return undefined;
  return flow as Flow;
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The ID token's claims, when it was issued by this issuer, for this client and this sign-in, and has not expired. */
export function idClaims(token: unknown, issuer: string, clientId: string, nonce: string, now = Date.now()): Record<string, unknown> {
  const parts = typeof token === 'string' ? token.split('.') : [];
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(parts.length === 3 ? parts[1]! : '', 'base64url').toString('utf8')) as Record<string, unknown>; }
  catch { throw failure('everid.failed', 'EverID gave no readable ID token'); }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer) throw failure('everid.failed', 'ID token from another issuer');
  if (!audience.includes(clientId) || audience.length > 1 && claims.azp !== clientId) throw failure('everid.failed', 'ID token for another client');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw failure('everid.failed', 'ID token expired');
  if (typeof claims.nonce !== 'string' || !equal(claims.nonce, nonce)) throw failure('everid.failed', 'ID token for another sign-in');
  if (typeof claims.sub !== 'string' || !claims.sub) throw failure('everid.failed', 'ID token without subject');
  return claims;
}

// No parameter properties here, as in login.ts
export class Oidc {
  readonly settings: OidcSettings;
  private readonly key: Buffer;
  private readonly fetch: typeof globalThis.fetch;
  private discovered: { value: Discovery; at: number } | undefined;
  constructor(settings: OidcSettings, key: Buffer, fetch: typeof globalThis.fetch = globalThis.fetch) {
    this.settings = settings; this.key = key; this.fetch = fetch;
  }

  private call(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), ...init, headers: { accept: 'application/json', ...init.headers } });
  }

  // read when first needed and again after an hour, so the daemon starts while EverID is down
  private async discovery(now: number): Promise<Discovery> {
    if (this.discovered && now - this.discovered.at < DISCOVERY_MS) return this.discovered.value;
    let value: Partial<Discovery>;
    try {
      const response = await this.call(this.settings.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      value = await response.json() as Partial<Discovery>;
    } catch (error) { throw failure('everid.unavailable', `EverID discovery failed: ${(error as Error).message}`); }
    if (typeof value.issuer !== 'string' || !sameIssuer(value.issuer, this.settings.issuer)
      || ![value.authorization_endpoint, value.token_endpoint].every((url) => typeof url === 'string' && /^https?:\/\//.test(url))) {
      throw failure('everid.unavailable', 'EverID discovery names another issuer or no endpoints');
    }
    this.discovered = { value: value as Discovery, at: now };
    return this.discovered.value;
  }

  /** Where to send the browser, and the sealed flow for the cookie the callback checks. */
  async start(next: string, now = Date.now()): Promise<{ location: string; cookie: string }> {
    const found = await this.discovery(now);
    const flow: Flow = { state: b64(randomBytes(24)), nonce: b64(randomBytes(24)), verifier: b64(randomBytes(32)), next, expires: now + FLOW_MS };
    const url = new URL(found.authorization_endpoint);
    for (const [name, value] of Object.entries({ response_type: 'code', client_id: this.settings.clientId, redirect_uri: this.settings.redirectUri,
      scope: 'openid email profile', state: flow.state, nonce: flow.nonce, code_challenge: b64(createHash('sha256').update(flow.verifier).digest()),
      code_challenge_method: 'S256' })) url.searchParams.set(name, value);
    return { location: url.href, cookie: sealFlow(this.key, flow) };
  }

  /**
   * EverID's end-session address, back to the page afterwards, for signing out there too (RP-initiated logout); undefined when
   * EverID names none or cannot be reached, so signing out of Everflow never depends on it.
   */
  async logout(idToken: string | undefined, now = Date.now()): Promise<string | undefined> {
    let found: Discovery;
    try { found = await this.discovery(now); } catch { return undefined; }
    if (typeof found.end_session_endpoint !== 'string' || !/^https?:\/\//.test(found.end_session_endpoint)) return undefined;
    const url = new URL(found.end_session_endpoint);
    if (idToken && ID_TOKEN.test(idToken)) url.searchParams.set('id_token_hint', idToken);
    url.searchParams.set('client_id', this.settings.clientId);
    url.searchParams.set('post_logout_redirect_uri', this.settings.postLogoutUri);
    return url.href;
  }

  /**
   * Checks EverID's answer at the callback: where to go on to and the ID token (the hint for signing out) when the account may
   * sign in, an everid.* error otherwise.
   */
  async finish(params: URLSearchParams, cookie: string | undefined, now = Date.now()): Promise<{ next: string; idToken: string }> {
    const flow = openFlow(this.key, cookie, now);
    if (!flow || !equal(params.get('state') ?? '', flow.state)) throw failure('everid.expired', 'No pending sign-in for this answer');
    const refused = params.get('error');
    if (refused) throw failure(refused === 'access_denied' ? 'everid.denied' : 'everid.failed', `EverID answered ${refused.slice(0, 64)}`);
    const code = params.get('code');
    if (!code) throw failure('everid.failed', 'EverID answered without a code');
    const found = await this.discovery(now);
    const basic = Buffer.from(`${encodeURIComponent(this.settings.clientId)}:${encodeURIComponent(this.settings.clientSecret)}`).toString('base64');
    let token: { id_token?: unknown; access_token?: unknown };
    try {
      const response = await this.call(found.token_endpoint, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.settings.redirectUri, code_verifier: flow.verifier }).toString() });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      token = await response.json() as typeof token;
    } catch (error) { throw failure('everid.failed', `EverID token exchange failed: ${(error as Error).message}`); }
    let profile = idClaims(token.id_token, found.issuer, this.settings.clientId, flow.nonce, now);
    // email and groups from userinfo, which carries them whether or not the provider copies claims into the ID token
    if (found.userinfo_endpoint && typeof token.access_token === 'string') {
      let info: Record<string, unknown>;
      try {
        const response = await this.call(found.userinfo_endpoint, { headers: { authorization: `Bearer ${token.access_token}` } });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
        info = await response.json() as Record<string, unknown>;
      } catch (error) { throw failure('everid.failed', `EverID userinfo failed: ${(error as Error).message}`); }
      if (info.sub !== profile.sub) throw failure('everid.failed', 'EverID userinfo for another subject');
      profile = { ...profile, ...info };
    }
    const groups = Array.isArray(profile.groups) ? profile.groups.filter((group): group is string => typeof group === 'string') : [];
    if (!groups.includes(this.settings.group)) throw failure('everid.denied', `EverID account not in ${this.settings.group}`);
    const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
    const bySubject = this.settings.subjects.includes(profile.sub as string);
    const byAdminEmail = groups.includes(this.settings.adminGroup) && !!email && email === this.settings.email;
    if (!bySubject && !byAdminEmail) throw failure('everid.denied', 'EverID account is not the Everflow account (sub not listed, or email without everid-admins)');
    return { next: flow.next, idToken: token.id_token as string };
  }
}
