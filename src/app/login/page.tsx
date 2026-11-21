import type { Metadata } from 'next';
import { LoginForm } from '@/components/login-form';
import { instance } from '@/web/instance';
import { safeNext } from '@/web/login';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata: Metadata = { title: 'Sign in · Everflow' };

// Served only under [web] public_origin without a session; the server gate sends a signed-in visitor on to `next`,
// which may be an address on [web] chat_origin.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams, current = instance();
  return <LoginForm next={safeNext(params.next, current.config.web.chat_origin)} />;
}
