import { clientChatPost } from '@/web/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ client: string; action: string }> }) {
  const { client, action } = await context.params;
  return clientChatPost(request, client, action);
}
