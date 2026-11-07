import { spawn } from 'node:child_process';
import { SourceError, trackSourceChild } from './source.ts';
import type { Source } from './source.ts';

export type JsonQuery = (args: string[], signal?: AbortSignal) => Promise<unknown>;

export async function cliJson(source: Source, executable: string, args: string[], signal?: AbortSignal, limits: { timeoutMs?: number; maxBytes?: number } = {}): Promise<unknown> {
  const timeout = limits.timeoutMs ?? 60000, maxBytes = limits.maxBytes ?? 16 * 1024 * 1024;
  if (!executable || executable.includes('\0') || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new SourceError(source, 'cli.invalid-options');
  if (signal?.aborted) throw new SourceError(source, 'cli.aborted');
  const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let size = 0, failure: unknown, closed = false, escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (error: unknown) => {
    failure ??= error;
    if (closed) return;
    escalation ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
    child.kill();
  };
  const aborted = () => stop(new SourceError(source, 'cli.aborted'));
  const exit = new Promise<number | null>((resolve) => {
    child.once('error', () => { failure ??= new SourceError(source, 'cli.start'); });
    child.once('close', (code) => { closed = true; resolve(code); });
  });
  child.stdout.on('data', (bytes: Buffer) => {
    size += bytes.length;
    if (size > maxBytes) stop(new SourceError(source, 'cli.result-limit'));
    else if (!failure) chunks.push(Buffer.from(bytes));
  });
  child.stderr.resume();
  const timer = setTimeout(() => stop(new SourceError(source, 'cli.timeout')), timeout);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  try {
    try { if (!closed) await trackSourceChild(child); } catch (error) { stop(error); }
    const status = await exit;
    if (failure !== undefined) throw failure;
    if (status !== 0) throw new SourceError(source, 'cli.failed', undefined, status ?? undefined);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new SourceError(source, 'cli.response-json'); }
  } finally {
    clearTimeout(timer); if (escalation) clearTimeout(escalation);
    signal?.removeEventListener('abort', aborted);
  }
}
