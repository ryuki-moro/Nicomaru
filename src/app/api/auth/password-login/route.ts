import { ok, route } from '@/lib/api/route';
import { ApiError, rateLimited, unauthenticated } from '@/lib/errors';
import { recordAuthenticationFailure } from '@/lib/services/audit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { passwordLoginSchema } from '@/lib/validation';
import { parsePasswordBody } from '../password-body';
import { enforceAuthRateLimit } from '../shared';

export const POST = route(async (request) => {
  const body = await parsePasswordBody(request, passwordLoginSchema);
  if (process.env.NICOMARU_DB === 'd1-local') {
    const { d1Auth } = await import('@/lib/d1/auth');
    const auth = await d1Auth();
    const result = await auth.handler(
      new Request(new URL('/api/auth/sign-in/email', process.env.APP_BASE_URL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: process.env.APP_BASE_URL!,
          'x-nicomaru-local-ip': '127.0.0.1',
        },
        body: JSON.stringify(body),
      }),
    );
    if (!result.ok) {
      if (result.status === 429) throw rateLimited();
      throw unauthenticated('メールアドレスまたはパスワードが正しくありません');
    }
    const response = ok({ redirectTo: '/' });
    for (const cookie of result.headers.getSetCookie())
      response.headers.append('set-cookie', cookie);
    return response;
  }
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
