import { headers } from 'next/headers';
import { InitiativesPage } from '@/components/initiatives/initiatives-page';
import { instance, withDatabase } from '@/web/instance';
import { readInitiatives } from '@/core/initiative-state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function OverviewPage() {
  const current = instance();
  const state = withDatabase(false, (db) => readInitiatives(db, current.config));
  const host = (await headers()).get('host')?.toLowerCase();
  const signOut = !!current.login && `https://${host}` === current.config.web.public_origin;
  return <><meta name="everflow-token" content={current.token} /><InitiativesPage initialState={state} token={current.token} signOut={signOut} /></>;
}
