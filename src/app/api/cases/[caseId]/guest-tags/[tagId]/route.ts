/**
 * PATCH  /api/cases/{caseId}/guest-tags/{tagId} — 自由タグの名前を変える
 * DELETE /api/cases/{caseId}/guest-tags/{tagId} — 自由タグを消す（ゲストからも外れる）
 */
import { noContent, ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { fromPostgresError, notFound, unprocessable } from '@/lib/errors';
import { assertGuestTagsEditable } from '@/lib/services/guest-tag-access';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { guestTagSchema } from '@/lib/validation';

type Context = { params: Promise<{ caseId: string; tagId: string }> };

export const PATCH = route(async (request: Request, context: Context) => {
  await requireRole('couple', 'planner', 'admin', 'system_admin');
  const { caseId, tagId } = await context.params;
  const input = await parseBody(request, guestTagSchema);
  const supabase = await createSupabaseServerClient();
  await assertGuestTagsEditable(supabase, caseId);

  const { data, error } = await supabase
    .from('case_guest_tags')
    .update({ name: input.name })
    .eq('id', tagId)
    .eq('case_id', caseId)
    .select('id, name')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') throw unprocessable('同じ名前のタグがすでにあります');
    throw fromPostgresError(error);
  }
  if (!data) throw notFound('タグが見つかりません');
  return ok(data);
});

export const DELETE = route(async (_request: Request, context: Context) => {
  await requireRole('couple', 'planner', 'admin', 'system_admin');
  const { caseId, tagId } = await context.params;
  const supabase = await createSupabaseServerClient();
  await assertGuestTagsEditable(supabase, caseId);

  // ゲストとの対応は外部キーの on delete cascade で一緒に消える
  const { data, error } = await supabase
    .from('case_guest_tags')
    .delete()
    .eq('id', tagId)
    .eq('case_id', caseId)
    .select('id');
  if (error) throw fromPostgresError(error);
  if (!data?.length) throw notFound('タグが見つかりません');
  return noContent();
});
