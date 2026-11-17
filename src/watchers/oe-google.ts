import type { OeCall } from './oemail.ts';
import { SourceError } from './source.ts';

// Gmail and Google Chat read through the OE Copilot agent (/api/communication/{gmail,gchat}/read) over the oemail endpoint path,
// so the Google grant and the Chat cookies stay on the OE host. Several reads share one endpoint call, `batch` per call.
export type OeGoogleRead = (bodies: Record<string, unknown>[], signal?: AbortSignal) => Promise<unknown[]>;

export function oeGoogleRead(call: OeCall, source: 'gmail' | 'gchat', account: string, batch: number): OeGoogleRead {
  return async (bodies, signal) => {
    const out: unknown[] = [];
    for (let at = 0; at < bodies.length; at += batch) {
      signal?.throwIfAborted();
      const chunk = bodies.slice(at, at + batch);
      const responses = await call(chunk.map((body) => ({ path: `/api/communication/${source}/read`, body: { ...body, account } })), signal);
      for (const response of responses) {
        // 409 from Chat: the agent's session needs a new import (autologin oe-gchat on the OE host does it).
        if (response.status < 200 || response.status >= 300) throw new SourceError(source, 'oemail.http', account, response.status);
        try { out.push(JSON.parse(response.body)); } catch { throw new SourceError(source, 'oemail.response-json', account); }
      }
    }
    return out;
  };
}
