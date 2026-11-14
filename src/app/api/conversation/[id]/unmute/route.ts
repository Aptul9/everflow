import { actionPost } from '@/web/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return actionPost(request, 'conversation', (await context.params).id, 'unmute');
}
