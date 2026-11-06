/**
 * POST /api/cases/{caseId}/guest-form — ゲスト向け回答URLの発行・切り替え。
 *
 * 新郎新婦（担当プランナーも可）が呼ぶ。既存の有効URLの失効と新規発行は
 * reissue_guest_form() が同一トランザクションで行い、案件へのアクセス可否も関数側で検証する。
 * 回答URLは新郎新婦があとから再表示できるよう暗号化して保存する（初回登録URLとは扱いが異なる）。
 */
import { ok, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { buildGuestFormUrl } from '@/lib/services/guests';
import { appBaseUrl } from '../../../auth/shared';
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
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { reissueGuestForm } = await import('@/lib/d1/guests');
      const token = await reissueGuestForm(await localDB(), user, caseId);
      return ok({ url: buildGuestFormUrl(appBaseUrl(request), token) }, 201);
    }
  },
);
