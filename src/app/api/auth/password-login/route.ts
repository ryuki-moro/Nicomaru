import { ok, route } from '@/lib/api/route';
import { ApiError, rateLimited, unauthenticated } from '@/lib/errors';
import { recordAuthenticationFailure } from '@/lib/services/audit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { passwordLoginSchema } from '@/lib/validation';
import { parsePasswordBody } from '../password-body';
import { enforceAuthRateLimit } from '../shared';

export const POST = route(async (request) => {
  const body = await parsePasswordBody(request, passwordLoginSchema);
  await enforceAuthRateLimit(request, 'password_login', body.email);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword(body).catch(() => {
    throw new ApiError('SERVICE_UNAVAILABLE');
  });
  if (error || !data.user) {
    // サービス停止は入力間違いと区別する。エラーメッセージに資格情報を混ぜない。
    if (error && (!error.status || error.status >= 500)) throw new ApiError('SERVICE_UNAVAILABLE');
    if (error?.status === 429) throw rateLimited();
    await recordAuthenticationFailure(body.email, 'password');
    throw unauthenticated('メールアドレスまたはパスワードが正しくありません');
  }
  return ok({ redirectTo: '/' });
});
