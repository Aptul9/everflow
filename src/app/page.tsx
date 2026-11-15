import { headers } from 'next/headers';
import { TicketBoard } from '@/components/tickets/ticket-board';
import { instance, withDatabase } from '@/web/instance';
import { readState, representation } from '@/web/state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function OverviewPage() {
  const current = instance();
  const state = withDatabase(false, (db) => readState(db, current.config));
  // under the public host the server gate already required a session, so offer to end it
  const host = (await headers()).get('host')?.toLowerCase();
  const signOut = !!current.login && `https://${host}` === current.config.web.public_origin;
  return <><meta name="everflow-token" content={current.token} /><TicketBoard initialState={state} initialEtag={representation(state).etag} token={current.token} initialNow={Date.now()} signOut={signOut} /></>;
}
