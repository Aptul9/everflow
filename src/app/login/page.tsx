import type { Metadata } from 'next';
import { LoginForm } from '@/components/login-form';
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
  return <LoginForm next={safeNext(params.next, current.config.web.chat_origin)} password={current.login?.password ?? true}
    everid={!!current.login?.oidc} {...(error ? { error } : {})} />;
}
