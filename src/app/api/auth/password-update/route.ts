import { noContent, route } from '@/lib/api/route';
import {
  ApiError,
  forbidden,
  fromPostgresError,
  unauthenticated,
  unprocessable,
} from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { awaitAudit } from '@/lib/services/audit-deadline';
import { passwordUpdateSchema } from '@/lib/validation';
import { parsePasswordBody } from '../password-body';

export const POST = route(async (request) => {
  const body = await parsePasswordBody(request, passwordUpdateSchema);
  const supabase = await createSupabaseServerClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) throw unauthenticated();
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('role, status')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();
  if (profileError) throw fromPostgresError(profileError);
  if (
    !profile ||
    !['planner', 'admin', 'system_admin'].includes(profile.role) ||
    !['active', 'invited'].includes(profile.status)
  )
    throw forbidden();
  const { error } = await supabase.auth.updateUser({ password: body.password }).catch(() => {
    throw new ApiError('SERVICE_UNAVAILABLE');
  });
  if (error) {
    throw unprocessable(
      error.code === 'weak_password'
        ? 'このパスワードは安全に使えないことが分かっています。別のパスワードをご入力ください'
        : 'パスワードを変更できませんでした。リンクの有効期限が切れている可能性があります',
    );
  }
  // Auth更新は確定済み。監査障害を更新失敗と返して再送させない。
  try {
    await awaitAudit(supabase.rpc('audit_password_changed'));
  } catch {
    console.warn('[audit] パスワード更新の監査記録を保存できませんでした');
  }
  return noContent();
});
