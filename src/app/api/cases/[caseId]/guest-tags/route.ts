/**
 * POST /api/cases/{caseId}/guest-tags — ゲストの自由タグを作る。
 *
 * 新郎新婦が作り、担当プランナーも確認・修正できる。参照・作成できる案件は RLS が決める。
 * 自動タグ（新郎新婦側・関係・年齢区分・アレルギー）は回答から導くため、ここでは扱わない。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { guestTagSchema } from '@/lib/validation';
export const POST = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        caseId: string;
      }>;
    },
  ) => {
    const user = await requireRole('couple', 'planner', 'admin', 'system_admin');
    const { caseId } = await context.params;
    const input = await parseBody(request, guestTagSchema);
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { createGuestTag } = await import('@/lib/d1/guests');
      return ok(await createGuestTag(await localDB(), user, caseId, input.name), 201);
    }
  },
);
