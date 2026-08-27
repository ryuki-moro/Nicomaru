/**
 * POST /api/auth/otp-request — ワンタイム認証メールの送信要求（P01）。
 *
 * 正本: 基本設計書 Version 1.2 6-3-1「認証方式」マジックリンク方式の設計方針。
 *   (1) 認証メールにはログインリンクと6桁のワンタイムコードの両方を記載する。
 *   (3) 送信要求にはレート制限を設け、メール送信の乱用を防止する。
 *
 * ブラウザから直接 signInWithOtp を呼ばずに本APIを挟むのは、
 * check_rate_limit（Service Role 専用RPC）で 429 を返せるようにするためである（4-3 P01）。
 */
import { noContent, parseBody, route } from '@/lib/api/route';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { otpRequestSchema } from '@/lib/validation';

import { appBaseUrl, enforceAuthRateLimit } from '../shared';

export const POST = route(async (request) => {
  const body = await parseBody(request, otpRequestSchema);
  await enforceAuthRateLimit(request, 'otp_request', body.email);

  const supabase = await createSupabaseServerClient();

  // shouldCreateUser: false —— 本APIはログイン用であり、ここでアカウントを作らせない。
  // couple の Auth ユーザーは招待トークンを消費する /api/auth/initial-register でのみ作成する（6-6-1）。
  //
  // emailRedirectTo をログイン画面自身にするのは、リンクを踏んだブラウザが
  // 要求元と別ブラウザでも「同じ画面で6桁コードを入力し直せる」着地にするため（6-3-1 の方針(1)）。
  const { error } = await supabase.auth.signInWithOtp({
    email: body.email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${appBaseUrl(request)}/login`,
    },
  });

  // 未登録メール・送信失敗でも応答を変えない。
  // 応答差からアカウントの存否を推定させないため（9章 利用者列挙の防止）。
  if (error) {
    console.error('[auth] otp-request failed', { code: error.code, status: error.status });
  }

  return noContent();
});
