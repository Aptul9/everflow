import { attachmentGet } from '@/web/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await context.params;
  return attachmentGet(request, id, index);
}
