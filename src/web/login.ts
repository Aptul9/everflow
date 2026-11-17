import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

// Sign-in for the page served under [web] public_origin. One account: EVERFLOW_LOGIN_USER and EVERFLOW_LOGIN_HASH
// (an scrypt hash from `hashPassword`, so the password itself is never stored). A session is an HMAC-signed cookie with
// its expiry; the key lives beside the database, so sessions survive a restart, and a changed account or password ends them.
export const COOKIE = 'everflow_session';
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const b64 = (bytes: Buffer) => bytes.toString('base64url');

export function hashPassword(password: string, salt = randomBytes(16)): string {
  if (!password) throw new Error('login.password-required');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64(salt)}$${b64(scryptSync(password, salt, 32, SCRYPT))}`;
}

/** Salt for a hash that must stay the same across deploys, so the sessions signed with it survive: derived from the user
 * alone. Never from the password: a salt is stored in clear inside the hash, and a cheap function of the password there
 * would let a guess be checked without paying for scrypt. A changed password still changes the hash. */
export function stableSalt(user: string): Buffer<ArrayBuffer> {
  const name = user.trim().toLowerCase();
  if (!name) throw new Error('login.user-required');
  return Buffer.from(createHash('sha256').update('everflow login salt v1\0' + name).digest().subarray(0, 16));
}

const HASH = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{43})$/;

export function verifyPassword(password: string, stored: string): boolean {
  const match = HASH.exec(stored);
  if (!match) return false;
  const [N, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const expected = Buffer.from(match[5]!, 'base64url');
  const actual = scryptSync(password, Buffer.from(match[4]!, 'base64url'), expected.length, { N, r, p, maxmem: SCRYPT.maxmem });
  return timingSafeEqual(actual, expected);
}

export interface Account { user: string; hash: string }

export function loginAccount(env: Record<string, string | undefined> = process.env): Account {
  const user = env.EVERFLOW_LOGIN_USER?.trim() ?? '', hash = env.EVERFLOW_LOGIN_HASH?.trim() ?? '';
  if (!user || !HASH.test(hash)) throw Object.assign(new Error('login.account-required'), { code: 'login.account-required' });
  return { user, hash };
}

/** The signing key beside the database (<db>.login-key, owner-only), created on first use. */
export function loginKey(db: string): Buffer {
  const path = db + '.login-key';
  try { return Buffer.from(fs.readFileSync(path, 'utf8').trim(), 'hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const key = randomBytes(32);
  fs.writeFileSync(path, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  return key;
}

// No parameter properties here: scripts/hash-password.ts loads this file through Node's type stripping
export class Sessions {
  private readonly key: Buffer;
  private readonly account: string;
  constructor(key: Buffer, account: Account) {
    if (key.length < 32) throw new Error('login.key');
    this.key = key;
    this.account = createHash('sha256').update(account.user.toLowerCase() + '\0' + account.hash).digest('hex');
  }
  private sign(expires: number): string { return b64(createHmac('sha256', this.key).update(`v1.${expires}.${this.account}`).digest()); }
  issue(now = Date.now()): string { const expires = now + SESSION_MS; return `v1.${expires}.${this.sign(expires)}`; }
  valid(value: string | undefined, now = Date.now()): boolean {
    const match = /^v1\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
    if (!match || Number(match[1]) <= now) return false;
    const expected = Buffer.from(this.sign(Number(match[1]))), supplied = Buffer.from(match[2]!);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}

// Failed sign-ins per client: 5 in 15 minutes lock that client for 15 minutes; 30 from everyone lock the form for all.
export class Limiter {
  private readonly failures = new Map<string, number[]>();
  private readonly perClient: number;
  private readonly overall: number;
  private readonly windowMs: number;
  constructor(perClient = 5, overall = 30, windowMs = 15 * 60 * 1000) { this.perClient = perClient; this.overall = overall; this.windowMs = windowMs; }
  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (kept.length) this.failures.set(key, kept); else this.failures.delete(key);
    return kept;
  }
  /** Milliseconds until this client may try again, 0 when it may now. */
  retryAfter(client: string, now = Date.now()): number {
    const mine = this.recent(client, now), all = this.recent('*', now);
    const wait = (list: number[], limit: number) => list.length >= limit ? list[list.length - limit]! + this.windowMs - now : 0;
    return Math.max(wait(mine, this.perClient), wait(all, this.overall));
  }
  fail(client: string, now = Date.now()): void {
    for (const key of [client, '*']) this.failures.set(key, [...this.recent(key, now), now]);
  }
  clear(client: string): void { this.failures.delete(client); }
}

export function cookieValue(header: string | undefined, name = COOKIE): string | undefined {
  return cookieValues(header, name)[0];
}

/** Every value of the cookie: a host-only and a domain cookie of the same name can both be sent. */
export function cookieValues(header: string | undefined, name = COOKIE): string[] {
  const values: string[] = [];
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) values.push(part.slice(at + 1).trim());
  }
  return values;
}

/** Domain for the session cookie: the public host when the chat host is under it, so the cookie reaches both and nothing else. */
export function cookieDomain(publicOrigin: string | undefined, chatOrigin: string | undefined): string | undefined {
  if (!publicOrigin || !chatOrigin) return undefined;
  const pub = new URL(publicOrigin).hostname, chat = new URL(chatOrigin).hostname;
  return chat.endsWith('.' + pub) ? pub : undefined;
}

/** Paths the sign-in page itself needs before there is a session. */
export function openPath(method: string, path: string): boolean {
  return method === 'GET' && (path === '/login' || path.startsWith('/_next/static/') || ['/icon.png', '/apple-icon.png', '/favicon.ico'].includes(path));
}

/** A same-site relative target to return to after signing in, or an absolute address on the chat origin; anything else goes to the board. */
export function safeNext(value: string | null | undefined, chatOrigin?: string): string {
  if (typeof value !== 'string') return '/';
  if (chatOrigin && /^https:\/\/[^\s\\]*$/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.origin === chatOrigin && !url.username && !url.password && (value.toLowerCase() === chatOrigin || value.toLowerCase().startsWith(chatOrigin + '/'))) return url.href;
    } catch { /* not an address */ }
    return '/';
  }
  return /^\/(?![/\\])[^\s]*$/.test(value) && !value.startsWith('/login') && !value.startsWith('/api/') ? value : '/';
}
