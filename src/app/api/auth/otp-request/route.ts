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
import { clientIp, localD1, usingD1 } from '@/lib/d1/mode';
import { noContent, parseBody, route } from '@/lib/api/route';
import { loginLinkUrl } from '@/lib/auth/login-link';
import { normalizeNext } from '@/lib/auth/next';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { otpRequestSchema } from '@/lib/validation';

import { appBaseUrl, enforceAuthRateLimit } from '../shared';

export const POST = route(async (request) => {
  const body = await parseBody(request, otpRequestSchema);
  if (usingD1()) {
    const { localDB } = await import('@/lib/d1/runtime');
    const db = await localDB();
    await (
      await import('@/lib/d1/auth-limits')
    ).authLimit(db, 'otp_request', body.email, localD1() ? undefined : clientIp(request.headers));
    if (await (await import('@/lib/d1/onboarding')).otpEligible(db, body.email)) {
      const auth = await (await import('@/lib/d1/auth')).d1Auth();
      await auth.api.sendVerificationOTP({
        body: { email: body.email.trim().toLowerCase(), type: 'sign-in' },
      });
    }
    return noContent();
  }
  await enforceAuthRateLimit(request, 'otp_request', body.email);

  const supabase = await createSupabaseServerClient();

  // 戻り先はログイン画面と同じ規則で検証し直す（本文は利用者が書き換えられる）。
  // 不正な next は黙って捨て、戻り先なし（役割別の初期画面）にする。
  const next = normalizeNext(body.next);

  // shouldCreateUser: false —— 本APIはログイン用であり、ここでアカウントを作らせない。
  // couple の Auth ユーザーは招待トークンを消費する /api/auth/initial-register でのみ作成する（6-6-1）。
  //
  // emailRedirectTo はメールのリンクの着地画面（/login/link）。テンプレートは
  // {{ .RedirectTo }} の後ろにメールアドレスと6桁コードをフラグメントで付け、
  // 着地画面がボタン押下時にコード入力と同じ otp-verify で検証する（6-3-1 方針(1)。
  // 要求元と別のブラウザでも成立し、開いただけではコードを消費しない）。
  // next を載せるのは、メールのリンク経由でもログイン後に元の画面へ戻すため（4-2）。
  // Supabase は戻り先のホスト名が Site URL と違うと黙って Site URL へ落とすので、
  // 共有環境では Site URL を APP_BASE_URL と同じホスト名にする（docs/環境の使い分け.md 3-1）。
  const { error } = await supabase.auth.signInWithOtp({
    email: body.email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: loginLinkUrl(appBaseUrl(request), next),
    },
  });

  // 未登録メール・送信失敗でも応答を変えない。
  // 応答差からアカウントの存否を推定させないため（9章 利用者列挙の防止）。
  if (error) {
    console.error('[auth] otp-request failed', { code: error.code, status: error.status });
  }

  return noContent();
});
