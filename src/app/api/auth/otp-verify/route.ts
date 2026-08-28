/**
 * POST /api/auth/otp-verify — 6桁ワンタイムコードの検証とセッション確立（P01）。
 *
 * 正本: 基本設計書 Version 1.2 6-3-1「認証方式」／4-3 P01（表4-11 ワンタイムコード）。
 *
 * リンク方式は「メールアプリの既定ブラウザ」と「LINE内ブラウザ」をまたぐと失敗しうるため、
 * 同一画面で完結するコード入力を併用する（6-3-1 方針(1)）。本APIはその受け口である。
 * Route Handler で verifyOtp を呼ぶことで、セッションCookieがサーバー側で発行され、
 * middleware・Server Component がそのまま同じセッションを読める。
 *
 * 【2段の制限】5-3 は2つの別々の制限を定めている。混ぜると片方が効かなくなる。
 *   otp_verify         : 送信元IP＋メールで1時間20回まで。総当たりの発信元を絞る
 *   otp_verify_failure : メールのみで、コードの有効期限（10分）内に失敗5回で当該コードを失効
 * 後者にIPを混ぜると、接続元を変えるだけで別カウンタになり失効しない。
 * 前者をメールだけにすると、1人の利用者への嫌がらせで正規の再送まで塞がれる。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { landingPathFor } from '@/lib/auth/session';
import type { Role } from '@/lib/constants';
import { forbidden, unprocessable } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { otpVerifySchema } from '@/lib/validation';

import {
  clearOtpVerifyFailures,
  enforceAuthRateLimit,
  isOtpCodeInvalidated,
  recordOtpVerifyFailure,
} from '../shared';

export const POST = route(async (request) => {
  const body = await parseBody(request, otpVerifySchema);
  // 総当たり対策。上限超過は 429（5-3 otp_verify）
  await enforceAuthRateLimit(request, 'otp_verify', body.email);

  // 5-3「検証失敗5回で当該コードを失効」。
  // Supabase 側のコードを直接無効化する手段は無いので、
  // 失効後は検証そのものを受け付けないことで同じ状態にする。
  // 失効を伝えるのは推測の手掛かりにならず（コードの正誤を明かさない）、
  // 「何度入れても通らない」まま放置するより再送へ導ける。
  if (await isOtpCodeInvalidated(body.email)) {
    throw unprocessable('ワンタイムコードは無効になりました', [
      { field: 'code', reason: 'お手数ですが、コードを送信し直してください' },
    ]);
  }

  const supabase = await createSupabaseServerClient();

  // type: 'email' はマジックリンク／OTPサインインの両方に対応する。
  const { data, error } = await supabase.auth.verifyOtp({
    email: body.email,
    token: body.code,
    type: 'email',
  });

  if (error || !data.user) {
    await recordOtpVerifyFailure(body.email);
    // コード誤り・期限切れ・使用済みを区別せず一律で返す（推測の手掛かりを与えない）
    throw unprocessable('ワンタイムコードが正しくないか、有効期限が切れています', [
      { field: 'code', reason: 'メールに記載のコードをもう一度ご確認ください' },
    ]);
  }

  // 認証できたので失効カウンタを消す。
  // 打ち間違えたあと正しく入力できた人を、次のログインまで縛らない。
  await clearOtpVerifyFailures(body.email);

  // 遷移先はロールで決める（4-2）。ここは本人セッションで引くので RLS 経由でよい。
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, status')
    .eq('auth_user_id', data.user.id)
    .maybeSingle();

  if (!profile || profile.status !== 'active') {
    // Auth ユーザーはあるが利用者プロフィールが無い／停止中。
    // 初回登録が完了していない couple もここに落ちる（6-6-1 の確認コード検証待ち）。
    throw forbidden('アカウントの初回登録が完了していないか、利用できない状態です');
  }

  return ok({ redirectTo: landingPathFor(profile.role as Role) });
});
