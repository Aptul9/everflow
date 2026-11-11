import { TicketBoard } from '@/components/tickets/ticket-board';
import { instance, withDatabase } from '@/web/instance';
import { readState, representation } from '@/web/state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function OverviewPage() {
  const current = instance();
  const state = withDatabase(false, (db) => readState(db, current.config));
  return <><meta name="everflow-token" content={current.token} /><TicketBoard initialState={state} initialEtag={representation(state).etag} token={current.token} initialNow={Date.now()} /></>;
}
