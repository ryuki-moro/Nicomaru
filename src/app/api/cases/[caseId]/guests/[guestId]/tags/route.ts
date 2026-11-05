/**
 * PUT /api/cases/{caseId}/guests/{guestId}/tags — ゲスト1人の自由タグを付け替える。
 *
 * 指定したタグIDの集合に置き換える。案件へのアクセス可否・アーカイブ済みの拒否・
 * 別案件のタグの混入防止は set_guest_tags() が同一トランザクションで行う。
 */
import { noContent, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { fromPostgresError, notFound } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { guestTagAssignmentSchema } from '@/lib/validation';

export const PUT = route(
  async (request: Request, context: { params: Promise<{ caseId: string; guestId: string }> }) => {
    await requireRole('couple', 'planner', 'admin', 'system_admin');
    const { caseId, guestId } = await context.params;
    const input = await parseBody(request, guestTagAssignmentSchema);
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

    const { error } = await supabase.rpc('set_guest_tags', {
      p_guest_id: guestId,
      p_tag_ids: input.tagIds,
    });
    if (error) throw fromPostgresError(error);
    return noContent();
  },
);
