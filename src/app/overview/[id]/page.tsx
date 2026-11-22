import { headers } from 'next/headers';
import { GuidePage } from '@/components/initiatives/guide-page';
import { instance, withDatabase } from '@/web/instance';
import { readGuide } from '@/core/initiative-state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function GuideRoute(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const current = instance();
  const state = withDatabase(false, (db) => readGuide(db, current.config, id));
  if (!state) return <main className="mx-auto max-w-xl px-6 py-16 text-center"><h1 className="text-lg font-semibold">Iniziativa non trovata</h1><p className="mt-2 text-sm text-muted-foreground"><a href="/overview" className="text-primary hover:underline">Torna alla panoramica</a></p></main>;
  const host = (await headers()).get('host')?.toLowerCase();
  const signOut = !!current.login && `https://${host}` === current.config.web.public_origin;
  const chatOrigin = current.clientChat && current.config.chats.enabled ? current.config.web.chat_origin : undefined;
  return <><meta name="everflow-token" content={current.token} /><GuidePage id={id} initialState={state} token={current.token} signOut={signOut} chatOrigin={chatOrigin} /></>;
}
