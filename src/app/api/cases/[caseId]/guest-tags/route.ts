/**
 * POST /api/cases/{caseId}/guest-tags — ゲストの自由タグを作る。
 *
 * 新郎新婦が作り、担当プランナーも確認・修正できる。参照・作成できる案件は RLS が決める。
 * 自動タグ（新郎新婦側・関係・年齢区分・アレルギー）は回答から導くため、ここでは扱わない。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { fromPostgresError, unprocessable } from '@/lib/errors';
import { GUEST_TAG_MAX_PER_CASE } from '@/lib/guest-tags';
import { assertGuestTagsEditable } from '@/lib/services/guest-tag-access';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { guestTagSchema } from '@/lib/validation';

export const POST = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    await requireRole('couple', 'planner', 'admin', 'system_admin');
    const { caseId } = await context.params;
    const input = await parseBody(request, guestTagSchema);
    const supabase = await createSupabaseServerClient();
    await assertGuestTagsEditable(supabase, caseId);

    const { count, error: countError } = await supabase
      .from('case_guest_tags')
      .select('id', { count: 'exact', head: true })
      .eq('case_id', caseId);
    if (countError) throw fromPostgresError(countError);
    if ((count ?? 0) >= GUEST_TAG_MAX_PER_CASE) {
      throw unprocessable(`タグは${GUEST_TAG_MAX_PER_CASE}個まで作成できます`);
    }

    const { data, error } = await supabase
      .from('case_guest_tags')
      .insert({ case_id: caseId, name: input.name })
      .select('id, name')
      .single();
    if (error) {
      if (error.code === '23505') throw unprocessable('同じ名前のタグがすでにあります');
      throw fromPostgresError(error);
    }
    return ok(data, 201);
  },
);
