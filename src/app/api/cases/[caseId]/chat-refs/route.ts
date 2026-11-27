/**
 * GET /api/cases/{caseId}/chat-refs?type=task|guest|seating&q= — チャットに添付できる項目の候補。
 * 見える範囲は閲覧者の権限で決まる（D1 層）。
 */
import { ok, route } from '@/lib/api/route';
import { requireAppUser } from '@/lib/auth/session';
import { listRefCandidates } from '@/lib/d1/chat-refs';
import { localDB } from '@/lib/d1/runtime';
import { badRequest, notFound } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';
import { chatRefQuerySchema } from '@/lib/validation';

export const GET = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const user = await requireAppUser();
    const { caseId } = await context.params;
    if (!isUuid(caseId)) throw notFound();
    const params = new URL(request.url).searchParams;
    const parsed = chatRefQuerySchema.safeParse({
      type: params.get('type'),
      q: params.get('q') ?? undefined,
    });
    if (!parsed.success) throw badRequest([{ field: 'type', reason: '種類を指定してください' }]);
    const items = await listRefCandidates(
      await localDB(),
      user,
      caseId,
      parsed.data.type,
      parsed.data.q,
    );
    return ok({ items });
  },
);
