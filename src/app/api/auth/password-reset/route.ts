/**
 * POST /api/auth/password-reset — パスワード再設定メールの送信（P03 ステップ1）。
 *
 * 正本: 基本設計書 Version 1.2 表6-6（未ログイン許可・レート制限）／4-3 P03／6-3-1。
 *
 * 対象はパスワードを持つ planner／admin／system_admin のみ。
 * couple はパスワードを設定しないため、そもそも対象外である（13-1）。
 * 送信経路は Resend を Supabase Auth の Custom SMTP に設定した1本に統一する（6-3-1）。
 */
import { noContent, parseBody, route } from '@/lib/api/route';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { passwordResetRequestSchema } from '@/lib/validation';

import { appBaseUrl, enforceAuthRateLimit } from '../shared';

export const POST = route(async (request) => {
  const body = await parseBody(request, passwordResetRequestSchema);
  await enforceAuthRateLimit(request, 'password_reset', body.email);

  const supabase = await createSupabaseServerClient();

  // 着地先は P03 のステップ2。mode=reset で見出し・案内文を再設定用に切り替える（4-3 P03）。
  const { error } = await supabase.auth.resetPasswordForEmail(body.email, {
    redirectTo: `${appBaseUrl(request)}/password?mode=reset`,
  });

  // 未登録メールでも 204 を返す。
  // 「登録されていません」と返すとアカウントの存否が判別でき、総当たりの下調べに使われるため（9章）。
  if (error) {
    console.error('[auth] password-reset failed', { code: error.code, status: error.status });
  }

  return noContent();
});
