/** S02 式場編集。式場コードと管理者アカウントはこのAPIでは変更しない。 */
import { z } from 'zod';

import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { fromPostgresError, notFound } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { venueUpdateSchema } from '@/lib/validation';

type RouteContext = { params: Promise<{ venueId: string }> };

export const PATCH = route<[RouteContext]>(async (request, context) => {
  await requireRole('system_admin');
  const { venueId } = await context.params;
  if (!z.string().uuid().safeParse(venueId).success) throw notFound('式場が見つかりません');
  const input = await parseBody(request, venueUpdateSchema);

  const patch: { name?: string; contact_email?: string | null; active?: boolean } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.contactEmail !== undefined) patch.contact_email = input.contactEmail;
  if (input.active !== undefined) patch.active = input.active;

  // Service Roleを使わず、venues_writeのsystem_admin制限を適用する。
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('venues')
    .update(patch)
    .eq('id', venueId)
    .select('id, name, code, contact_email, active, updated_at')
    .maybeSingle();
  if (error) throw error.code === '22P02'
    ? notFound('式場が見つかりません') : fromPostgresError(error);
  if (!data) throw notFound('式場が見つかりません');

  // 実行者はRPC内のauth.uid()から解決。氏名・メールの値は監査ログへ複製しない。
  // 更新確定後の監査失敗を更新失敗として返すと再送を誘発するため、記録だけを残す。
  try {
    const audit = await supabase.rpc('log_audit', {
      p_action: 'venue.update',
      p_target_type: 'venues',
      p_target_id: data.id,
      p_detail: { changed: Object.keys(patch) },
    });
    if (audit.error) console.error('[api] 式場更新の監査ログを記録できませんでした', audit.error);
  } catch (auditError) {
    console.error('[api] 式場更新の監査ログを記録できませんでした', auditError);
  }

  return ok({
    id: data.id,
    name: data.name,
    code: data.code,
    contactEmail: data.contact_email,
    active: data.active,
    updatedAt: data.updated_at,
  });
});
