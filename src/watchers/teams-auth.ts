import { createDecipheriv, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { CookieRow } from '../windows/snapshot.ts';
import { snapshotCookies } from '../windows/snapshot.ts';
import { createDpapi } from '../windows/dpapi.ts';
import { createKernel, NativeError, windowsPath } from '../windows/kernel.ts';

export interface TeamsAccount { upn: string; ic3: string; exp: number; region: string; oid?: string; tid?: string }
export interface TeamsAuthState { version: 1; accounts: TeamsAccount[]; attempted?: number; harvested?: number }
export interface TeamsAuthDependencies { load(): TeamsAuthState | null; save(state: TeamsAuthState): void; harvest(signal?: AbortSignal): Promise<TeamsAccount[]>; now?: () => number }
export function decryptCookie(raw: Buffer, key: Buffer, host: string, requirePrefix = false): Buffer {
  const format = raw.subarray(0, 3).toString('ascii');
  if (format === 'v21') throw new NativeError('cookie.unsupported-v21');
  if (format !== 'v10' && format !== 'v20') return Buffer.from(raw);
  if (key.length !== 32 || raw.length < 31) throw new NativeError('cookie.invalid-length');
  let partial: Buffer | undefined, clear: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(3, 15));
    decipher.setAuthTag(raw.subarray(-16));
    partial = decipher.update(raw.subarray(15, -16));
    clear = Buffer.concat([partial, decipher.final()]);
  } catch { throw new NativeError('cookie.aes-authentication'); }
  finally { partial?.fill(0); }
  const digest = createHash('sha256').update(host, 'utf8').digest();
  if (clear.length >= 32 && timingSafeEqual(clear.subarray(0, 32), digest)) {
    const value = Buffer.from(clear.subarray(32)); clear.fill(0); return value;
  }
  if (requirePrefix) { clear.fill(0); throw new NativeError('cookie.host-prefix'); }
  return clear;
}

export function stripToken(raw: string): string {
  const decoded = raw.replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replaceAll('%', ''), 'hex').toString('utf8'));
  return /^bearer[= ]/i.test(decoded) ? decoded.slice(7) : decoded;
}

export function jwtMetadata(token: string): { exp?: number; upn?: string; unique_name?: string; oid?: string; tid?: string } {
  try {
    if (token.length > 131072) return {};
    const body = token.split('.')[1];
    if (!body) return {};
    const value: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function region(path: string): string {
  const parts = path.split('/').filter(Boolean);
  let index = parts.indexOf('mt');
  if (index < 0) return 'emea';
  index++;
  if (parts[index] === 'part') index++;
  const value = parts[index]?.split('-')[0] || 'emea';
  if (!/^[a-z][a-z0-9]{0,15}$/.test(value)) throw new NativeError('auth.invalid-region');
  return value;
}

export function harvestCookieAccounts(rows: CookieRow[], key: Buffer, requirePrefix: boolean): TeamsAccount[] {
  const accounts = new Map<string, TeamsAccount>(), regions = new Map<string, string>();
  for (const row of rows) {
    const host = row.host_key.toLowerCase();
    const accountCookie = row.name === 'authtoken_asm' && (host === 'asyncgw.teams.microsoft.com' || host.endsWith('.asyncgw.teams.microsoft.com'));
    const regionCookie = row.name === 'authtoken' && host === 'teams.microsoft.com';
    if (!accountCookie && !regionCookie) continue;
    const clear = decryptCookie(Buffer.from(row.encrypted_value), key, row.host_key, requirePrefix);
    try {
      const ic3 = stripToken(clear.toString('utf8'));
      const claims = jwtMetadata(ic3);
      if (!Number.isSafeInteger(claims.exp) || typeof claims.exp !== 'number') throw new NativeError('auth.token-metadata');
      if (accountCookie) {
        const upn = claims.upn || claims.unique_name;
        if (typeof upn !== 'string' || !upn.trim() || /[\r\n\0]/.test(upn)) throw new NativeError('auth.token-metadata');
        const name = upn.toLowerCase();
        if ((accounts.get(name)?.exp ?? -Infinity) >= claims.exp) continue;
        accounts.set(name, { upn: name, exp: claims.exp, ic3, region: 'emea',
          ...(typeof claims.oid === 'string' ? { oid: claims.oid } : {}), ...(typeof claims.tid === 'string' ? { tid: claims.tid } : {}) });
      } else if (typeof claims.oid === 'string') regions.set(claims.oid, region(row.path));
    } finally { clear.fill(0); }
  }
  if (!accounts.size) throw new NativeError('auth.no-cookie-accounts');
  if (accounts.size > 1024) throw new NativeError('auth.account-limit');
  return [...accounts.values()].map((account) => ({ ...account, region: account.oid && regions.get(account.oid) || 'emea' })).sort((a, b) => a.upn.localeCompare(b.upn));
}

function sensitiveJson(bytes: Buffer, code: string): any {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new NativeError(code); }
}

function cacheState(value: any): TeamsAuthState {
  if (value?.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 1024) throw new NativeError('auth.cache-schema');
  const accounts: TeamsAccount[] = value.accounts.map((account: any) => {
    if (typeof account?.upn !== 'string' || !account.upn.trim() || /[\r\n\0]/.test(account.upn) || typeof account.ic3 !== 'string' || !account.ic3 || account.ic3.length > 131072
      || !Number.isSafeInteger(account.exp) || account.region !== undefined && (typeof account.region !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(account.region))) throw new NativeError('auth.cache-schema');
    const metadata = jwtMetadata(account.ic3);
    if (!Number.isSafeInteger(metadata.exp) || typeof metadata.exp !== 'number') throw new NativeError('auth.cache-token');
    const name = metadata.upn || metadata.unique_name;
    if (typeof name !== 'string' || name.toLowerCase() !== account.upn.toLowerCase()) throw new NativeError('auth.cache-token');
    return { upn: account.upn.toLowerCase(), ic3: account.ic3, exp: Math.min(account.exp, metadata.exp), region: account.region || 'emea',
      ...(typeof account.oid === 'string' ? { oid: account.oid } : typeof metadata.oid === 'string' ? { oid: metadata.oid } : {}),
      ...(typeof account.tid === 'string' ? { tid: account.tid } : {}) };
  });
  if (new Set(accounts.map((account) => account.upn)).size !== accounts.length) throw new NativeError('auth.cache-schema');
  for (const name of ['attempted', 'harvested']) if (value[name] !== undefined && (typeof value[name] !== 'number' || !Number.isFinite(value[name]))) throw new NativeError('auth.cache-schema');
  return { version: 1, accounts, ...(value.attempted === undefined ? {} : { attempted: value.attempted }), ...(value.harvested === undefined ? {} : { harvested: value.harvested }) };
}

export function protectedTeamsCache(options: { path: string; bootstrap?: string }, dpapi = createDpapi()) {
  const path = resolve(options.path);
  if (!isAbsolute(options.path) || windowsPath(path).split('\\').includes('teamsmcp') || options.bootstrap && windowsPath(path) === windowsPath(options.bootstrap)) throw new NativeError('auth.cache-separation');
  const read = (filename: string): TeamsAuthState | null => {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new NativeError('auth.cache-read'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new NativeError('auth.cache-file');
    const clear = dpapi.unprotect(fs.readFileSync(filename));
    try { return cacheState(sensitiveJson(clear, 'auth.cache-json')); } finally { clear.fill(0); }
  };
  const parents = () => {
    let current = parse(path).root;
    for (const part of relative(current, dirname(path)).split(sep).filter(Boolean)) {
      current = join(current, part);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new NativeError('auth.cache-path'); }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new NativeError('auth.cache-path');
    }
  };
  return {
    load(): TeamsAuthState | null { return read(path) ?? (options.bootstrap ? read(options.bootstrap) : null); },
    save(state: TeamsAuthState): void {
      parents();
      const clear = Buffer.from(JSON.stringify(cacheState(state)));
      let protectedBytes: Buffer;
      try { protectedBytes = dpapi.protect(clear); } finally { clear.fill(0); }
      fs.mkdirSync(dirname(path), { recursive: true });
      parents();
      const temporary = path + '.' + randomUUID() + '.tmp';
      try { fs.writeFileSync(temporary, protectedBytes, { flag: 'wx' }); fs.renameSync(temporary, path); }
      catch { throw new NativeError('auth.cache-write'); }
    },
  };
}

export function discoverTeamsProfile(base: string): string {
  if (!isAbsolute(base) || base.startsWith('\\\\')) throw new NativeError('auth.profile-path');
  try {
    const candidates = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('WV2Profile_'))
      .map((entry) => join(base, entry.name)).map((profile) => {
        try { return { profile, modified: fs.statSync(join(profile, 'Network', 'Cookies')).mtimeMs }; } catch { return null; }
      }).filter((value) => value !== null).sort((a, b) => b.modified - a.modified);
    if (!candidates[0]) throw new NativeError('auth.profile-missing');
    return candidates[0].profile;
  } catch (error) { if (error instanceof NativeError) throw error; throw new NativeError('auth.profile-unavailable'); }
}

export async function liveTeamsAccounts(options: { profile: string; scratchRoot: string }, signal?: AbortSignal, ownedKernel?: ReturnType<typeof createKernel>): Promise<TeamsAccount[]> {
  if (!isAbsolute(options.profile) || options.profile.startsWith('\\\\')) throw new NativeError('auth.profile-path');
  using native = ownedKernel ?? createKernel();
  const snapshot = await snapshotCookies(join(options.profile, 'Network', 'Cookies'), options.scratchRoot, native, signal);
  const path = join(dirname(options.profile), 'Local State');
  const { handle, error } = native.shared(path);
  if (!handle) throw new NativeError('auth.local-state-unavailable', error!);
  let stateBytes: Buffer;
  try { native.validate(handle, path); stateBytes = native.mapped(handle, 16 * 1024 * 1024); } finally { native.close(handle); }
  let key: Buffer | undefined;
  try {
    const state = sensitiveJson(stateBytes, 'auth.local-state-json');
    const wrapped = state?.os_crypt?.encrypted_key;
    if (typeof wrapped !== 'string') throw new NativeError(state?.os_crypt?.app_bound_encrypted_key ? 'auth.unsupported-app-bound-key' : 'auth.key-missing');
    const encrypted = Buffer.from(wrapped, 'base64');
    if (encrypted.subarray(0, 5).toString('ascii') !== 'DPAPI') throw new NativeError('auth.key-not-dpapi');
    key = createDpapi().unprotect(encrypted.subarray(5));
    if (key.length !== 32) throw new NativeError('auth.invalid-key-length');
    return harvestCookieAccounts(snapshot.rows, key, snapshot.version >= 24);
  } finally { key?.fill(0); stateBytes.fill(0); }
}

export class TeamsAuth {
  private readonly dependencies: TeamsAuthDependencies;
  private state: TeamsAuthState | undefined;
  private readonly known = new Set<string>();
  private refreshing: Promise<void> | undefined;
  constructor(dependencies: TeamsAuthDependencies) { this.dependencies = dependencies; }
  private load(reload = false): TeamsAuthState {
    if (!this.state || reload) this.state = this.dependencies.load() ?? this.state ?? { version: 1, accounts: [] };
    for (const account of this.state.accounts) this.known.add(account.upn.toLowerCase());
    return this.state;
  }
  knownAccounts(): string[] { this.load(); return [...this.known].sort(); }
  private now(): number { return (this.dependencies.now?.() ?? Date.now()) / 1000; }
  private async refresh(signal?: AbortSignal): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const current = this.load(true), now = this.now();
    if (now - (current.attempted ?? -Infinity) < 60) throw new NativeError('auth.refresh-throttled');
    this.state = { ...current, attempted: now };
    this.dependencies.save(this.state);
    this.refreshing = (async () => {
      signal?.throwIfAborted();
      const fresh = await this.dependencies.harvest(signal);
      const merged = new Map(this.state!.accounts.map((account) => [account.upn.toLowerCase(), account]));
      for (const account of fresh) { merged.set(account.upn.toLowerCase(), account); this.known.add(account.upn.toLowerCase()); }
      this.state = { version: 1, accounts: [...merged.values()], attempted: now, harvested: this.now() };
      this.dependencies.save(this.state);
    })();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }
  async accounts(signal?: AbortSignal): Promise<TeamsAccount[]> {
    const current = this.load();
    if (!current.accounts.length || current.accounts.some((account) => account.exp <= this.now() + 120)) {
      try { await this.refresh(signal); }
      catch (error) { if (!this.load().accounts.some((account) => account.exp > this.now())) throw error; }
    }
    const usable = this.load().accounts.filter((account) => account.exp > this.now());
    if (!usable.length) throw new NativeError('auth.no-valid-accounts');
    return usable;
  }
  async refreshRejected(account: TeamsAccount, signal?: AbortSignal): Promise<TeamsAccount> {
    const usable = () => this.load(true).accounts.find((candidate) => candidate.upn.toLowerCase() === account.upn.toLowerCase() && candidate.ic3 !== account.ic3 && candidate.exp > this.now());
    const cached = usable();
    if (cached) return cached;
    await this.refresh(signal);
    const fresh = usable();
    if (!fresh) throw new NativeError('auth.refresh-unavailable');
    return fresh;
  }
}
