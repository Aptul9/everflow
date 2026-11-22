import { headers } from 'next/headers';
import { InitiativesPage } from '@/components/initiatives/initiatives-page';
import { instance, withDatabase } from '@/web/instance';
import { readInitiatives } from '@/core/initiative-state';
import { readState, representation } from '@/web/state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function OverviewPage() {
  const current = instance();
  const state = withDatabase(false, (db) => readInitiatives(db, current.config));
  const board = withDatabase(false, (db) => readState(db, current.config));
  const host = (await headers()).get('host')?.toLowerCase();
  const signOut = !!current.login && `https://${host}` === current.config.web.public_origin;
  return <><meta name="everflow-token" content={current.token} /><InitiativesPage initialState={state} initialBoard={board} initialEtag={representation(board).etag} token={current.token} initialNow={Date.now()} signOut={signOut} /></>;
}
