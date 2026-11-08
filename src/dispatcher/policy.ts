import type { Config } from './config.ts';

export function excluded(name: string): boolean {
  return name.toLowerCase() === '_secrets' || name.toLowerCase().startsWith('.unison.');
}

export function safeComponent(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' && !/[. ]$/.test(name)
    && !/[\x00-\x1f<>:"|?*%\\/]/.test(name) && !excluded(name)
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
}

export function isNotePath(value: string): boolean {
  return typeof value === 'string' && value.length <= 1_024 && value.normalize('NFKC') === value
    && /\.md$/i.test(value) && value.split('/').every(safeComponent);
}

// null: every account of the source is on. A list turns every other account of that source off.
export function sourceAccounts(cfg: object, source: string): Set<string> | null {
  const value = (cfg as { sources?: Record<string, { accounts?: unknown } | undefined> }).sources?.[source]?.accounts;
  return Array.isArray(value) ? new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().toLowerCase())) : null;
}

export function clientsFor(cfg: Pick<Config, 'clients'>, account: string, addresses: readonly string[]): string[] {
  const clients = Object.entries(cfg.clients);
  const hit = clients.filter(([, client]) => client.accounts.some((value) => value.toLowerCase() === account.toLowerCase()));
  if (hit.length) return hit.map(([name]) => name);
  const domains = new Set([...addresses, account].filter((value) => value.includes('@')).map((value) => value.split('@').at(-1)!.toLowerCase()));
  return clients.filter(([, client]) => client.domains.some((domain) => domains.has(domain.toLowerCase()))).map(([name]) => name);
}
