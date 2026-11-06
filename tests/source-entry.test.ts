import { expect, test, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { isEntrypoint, runSource, safeSourceDiagnostic, SourceError, watcherArguments } from '../src/watchers/source.ts';

test('compiled entrypoint detection handles Windows spaces without autostart on import', () => {
  const path = 'C:/synthetic path/watchers/teams.js';
  expect(isEntrypoint(pathToFileURL(path).href, path)).toBe(true);
  expect(isEntrypoint(pathToFileURL(path).href, 'C:/synthetic path/other.js')).toBe(false);
  expect(isEntrypoint(pathToFileURL(path).href, undefined)).toBe(false);
});

test('once failure is nonzero, diagnostics stay on stderr, lifecycle and signal listeners close', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const close = vi.fn();
  try {
    expect(await runSource('teams', { once: true, poll: 30 }, () => { throw new SourceError('teams', 'teams.fixture-unavailable', 'a@example.invalid'); }, { close })).toBe(1);
    expect(stderr.mock.calls.map((call) => String(call[0]))).toEqual(['{"source":"teams","code":"teams.fixture-unavailable","account":"a@example.invalid"}\n']);
  } finally { stderr.mockRestore(); }
  expect(close).toHaveBeenCalledOnce();
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
});

test('aborted polling closes owned lifecycle without waiting for the next full poll', async () => {
  const controller = new AbortController(), close = vi.fn();
  const scan = vi.fn(() => { queueMicrotask(() => controller.abort()); });
  expect(await runSource('teamsrelay', { once: false, poll: 86400 }, scan, { close }, controller.signal)).toBe(0);
  expect(scan).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});

test('source CLI requires explicit since and rejects invalid poll without loading default configuration', () => {
  expect(() => watcherArguments([])).toThrow(/source.since-required/);
  expect(() => watcherArguments(['--since', '2026-11-04T00:00:00Z', '--poll', '0'])).toThrow(/source.poll/);
  expect(watcherArguments(['--since', '2026-11-04T00:00:00Z', '--once', '--expected-account', 'A@Example.Invalid'])).toMatchObject({
    since: '2026-11-04T00:00:00.000Z', once: true, expectedAccounts: ['a@example.invalid'],
  });
});

test('unexpected sensitive parser and transport errors retain only fixed nonsecret diagnostic codes', () => {
  const secret = 'SYNTHETIC_TOKEN_DO_NOT_PRINT';
  const diagnostic = safeSourceDiagnostic(new SyntaxError(secret), 'teams');
  expect(diagnostic).toEqual({ source: 'teams', code: 'source.unexpected' });
  expect(JSON.stringify(diagnostic)).not.toContain(secret);
});

test('fixed argument-check IDs survive CLI diagnostics without exposing arbitrary TypeError messages', () => {
  expect(safeSourceDiagnostic(new TypeError('source.since-required'), 'outlook')).toEqual({ source: 'outlook', code: 'source.since-required' });
  expect(safeSourceDiagnostic(new TypeError('SYNTHETIC_TOKEN_DO_NOT_PRINT'), 'outlook')).toEqual({ source: 'outlook', code: 'source.unexpected' });
});
