'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OverviewState } from '../../lib/web-types.ts';

export const STATE_DEADLINE_MS = 8_000;

export function useOverview(initialState: OverviewState, initialEtag: string, token: string, initialNow = Date.now()) {
  const [state, setState] = useState(initialState);
  const [now, setNow] = useState(initialNow);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const etag = useRef(initialEtag);
  const mounted = useRef(true);
  const polling = useRef(false);
  const stale = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const submitting = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    if (polling.current || !mounted.current) return;
    polling.current = true;
    setNow(Date.now());
    const controller = new AbortController();
    controllers.current.add(controller);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        reject(new Error(timedOut ? 'State request deadline exceeded' : 'State request cancelled'));
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, STATE_DEADLINE_MS);
    try {
      const operation = (async () => {
        const response = await fetch('/api/state', { headers: { 'if-none-match': etag.current }, signal: controller.signal, cache: 'no-store' });
        const next = response.status === 200 ? await response.json() as OverviewState : null;
        return { response, next };
      })();
      const { response, next } = await Promise.race([operation, aborted]);
      if (!mounted.current || controller.signal.aborted) return;
      if (response.status === 403) { stale.current = true; if (mounted.current) setExpired(true); throw new Error('Local Host rejected'); }
      if (response.status !== 304) {
        if (!response.ok) throw new Error(`State request failed (${response.status})`);
        if (!next || typeof next.tickets_enabled !== 'boolean' || !next.groups || !Array.isArray(next.health) || !next.problems) throw new Error('Invalid state response');
        if (mounted.current) {
          setState(next);
          etag.current = response.headers.get('etag') ?? '';
        }
      }
      if (mounted.current) setUnreachable(null);
    } catch {
      if (mounted.current && (timedOut || !controller.signal.aborted)) setUnreachable((first) => first ?? new Date().toISOString());
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      controllers.current.delete(controller);
      polling.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const active = controllers.current;
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { mounted.current = false; clearInterval(timer); for (const controller of active) controller.abort(); active.clear(); };
  }, [refresh]);

  const post = useCallback(async (key: string, path: string, input: Record<string, string | number | null> = {}) => {
    if (stale.current) throw new Error('Reload page before submitting again.');
    if (submitting.current.has(key)) throw new Error('Action already submitting');
    const controller = new AbortController();
    controllers.current.add(controller);
    submitting.current.add(key);
    setPending(new Set(submitting.current));
    setErrors((previous) => { const next = { ...previous }; delete next[key]; return next; });
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dispatcher-token': token },
        body: JSON.stringify(input), signal: controller.signal, credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
      if (response.status === 403) { stale.current = true; if (mounted.current) setExpired(true); }
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
        throw new Error(typeof failure?.error?.message === 'string' ? failure.error.message : `Action failed (${response.status})`);
      }
      const result = await response.json() as { ticket?: number; job?: number; conversation?: number };
      const committed = result.ticket ?? result.job ?? result.conversation;
      if (!Number.isSafeInteger(committed) || (committed ?? 0) <= 0) throw new Error('Invalid committed action response');
      if (mounted.current) { setNotice('Local action saved.'); void refresh(); }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Local action failed';
      if (mounted.current && !controller.signal.aborted) setErrors((previous) => ({ ...previous, [key]: message }));
      throw error;
    } finally {
      controllers.current.delete(controller);
      submitting.current.delete(key);
      if (mounted.current) setPending(new Set(submitting.current));
    }
  }, [refresh, token]);

  return { state, now, unreachable, expired, pending, errors, notice, post, refresh };
}
