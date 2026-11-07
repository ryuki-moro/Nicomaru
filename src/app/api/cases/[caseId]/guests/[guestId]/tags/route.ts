/**
 * PUT /api/cases/{caseId}/guests/{guestId}/tags — ゲスト1人の自由タグを付け替える。
 *
 * 指定したタグIDの集合に置き換える。案件へのアクセス可否・アーカイブ済みの拒否・
 * 別案件のタグの混入防止は set_guest_tags() が同一トランザクションで行う。
 */
import { noContent, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { guestTagAssignmentSchema } from '@/lib/validation';
export const PUT = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        caseId: string;
        guestId: string;
      }>;
    },
  ) => {
    const user = await requireRole('couple', 'planner', 'admin', 'system_admin');
    const { caseId, guestId } = await context.params;
    const input = await parseBody(request, guestTagAssignmentSchema);
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { setGuestTags } = await import('@/lib/d1/guests');
      await setGuestTags(await localDB(), user, caseId, guestId, input.tagIds);
      return noContent();
    }
  },
);
