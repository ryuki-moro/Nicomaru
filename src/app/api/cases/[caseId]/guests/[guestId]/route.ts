/**
 * PATCH /api/cases/{caseId}/guests/{guestId} — ゲスト1人の確認・修正（#179）。
 *
 * 新郎新婦（担当プランナーも可）が、確認済み／確認待ちの切り替え、ご関係の修正、
 * 役割（主賓・乾杯のご発声）と肩書きの設定を行う。送った項目だけを更新する。
 * 案件へのアクセス可否・アーカイブ済みの拒否・出席者だけが確認済みにできる決まりは
 * review_case_guest() が同一トランザクションで行う。ゲストの元の回答は上書きしない。
 */
import { noContent, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { guestReviewSchema } from '@/lib/validation';
export const PATCH = route(
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
    const input = await parseBody(request, guestReviewSchema);
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { reviewGuest } = await import('@/lib/d1/guests');
      await reviewGuest(await localDB(), user, caseId, guestId, input);
      return noContent();
    }
  },
);
