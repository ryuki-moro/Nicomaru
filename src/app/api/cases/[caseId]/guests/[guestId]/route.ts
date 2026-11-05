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
import { fromPostgresError, notFound } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { guestReviewSchema } from '@/lib/validation';

export const PATCH = route(
  async (request: Request, context: { params: Promise<{ caseId: string; guestId: string }> }) => {
    await requireRole('couple', 'planner', 'admin', 'system_admin');
    const { caseId, guestId } = await context.params;
    const input = await parseBody(request, guestReviewSchema);
    const supabase = await createSupabaseServerClient();

    // パスの caseId とゲストの所属が食い違う指定は、存在しないものとして扱う
    const { data: guest, error: guestError } = await supabase
      .from('case_guests')
      .select('id')
      .eq('id', guestId)
      .eq('case_id', caseId)
      .maybeSingle();
    if (guestError) throw fromPostgresError(guestError);
    if (!guest) throw notFound('ゲストが見つかりません');

    const patch: Record<string, unknown> = {};
    if (input.checked !== undefined) patch.checked = input.checked;
    if (input.relationship !== undefined) patch.relationship = input.relationship;
    if (input.seatRole !== undefined) patch.seat_role = input.seatRole;
    if (input.seatTitle !== undefined) patch.seat_title = input.seatTitle;

    const { error } = await supabase.rpc('review_case_guest', {
      p_guest_id: guestId,
      p_patch: patch,
    });
    if (error) throw fromPostgresError(error);
    return noContent();
  },
);
