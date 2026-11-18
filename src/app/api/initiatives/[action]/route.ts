import { initiativesPost } from '@/web/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  return initiativesPost(request, (await context.params).action);
}
