import type { Metadata } from 'next';
import { instance } from '@/web/instance';
import { safeNext } from '@/web/login';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata: Metadata = { title: 'Sign in · Everflow' };

const EVERID_ERRORS = ['everid.denied', 'everid.expired', 'everid.unavailable', 'everid.failed'] as const;

// Served only under [web] public_origin without a session; the server gate sends a signed-in visitor on to `next`,
// which may be an address on [web] chat_origin. `error` is set by the EverID callback when it refused the sign-in.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams, current = instance();
  const error = EVERID_ERRORS.find((code) => code === params.error);
  const next = safeNext(params.next, current.config.web.chat_origin);
  return (
    <main className="relative grid min-h-dvh place-items-center bg-background px-4 py-10">
      <div className="grid max-w-sm gap-4 text-center">
        <h1 className="text-xl font-semibold">{error ? 'Accesso non riuscito' : current.login?.oidc ? 'Disconnessione effettuata' : 'Accesso non disponibile'}</h1>
        {error && <p role="alert">Non è stato possibile completare l'accesso.</p>}
        {current.login?.oidc && <a className="underline" href={`/oidc/start?next=${encodeURIComponent(next)}`}>Accedi</a>}
      </div>
    </main>
  );
}
