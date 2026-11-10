import { clientPost } from '@/web/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ name: string }> }) {
  return clientPost(request, (await context.params).name);
}
