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
import { clientIp, localD1 } from '@/lib/d1/mode';
import { unprocessable } from '@/lib/errors';
import { otpVerifySchema } from '@/lib/validation';
export const POST = route(async (request) => {
  const body = await parseBody(request, otpVerifySchema);
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const db = await localDB();
    await (
      await import('@/lib/d1/auth-limits')
    ).authLimit(db, 'otp_verify', body.email, localD1() ? undefined : clientIp(request.headers));
    const fail = () =>
      unprocessable('ワンタイムコードが正しくないか、有効期限が切れています', [
        { field: 'code', reason: 'コードを確認するか、送信し直してください' },
      ]);
    if (!(await (await import('@/lib/d1/onboarding')).otpEligible(db, body.email))) throw fail();
    const auth = await (await import('@/lib/d1/auth')).d1Auth();
    const result = await auth.handler(
      new Request(new URL('/api/auth/sign-in/email-otp', process.env.APP_BASE_URL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: process.env.APP_BASE_URL!,
          'x-nicomaru-local-ip': clientIp(request.headers),
        },
        body: JSON.stringify({ email: body.email.trim().toLowerCase(), otp: body.code }),
      }),
    );
    if (!result.ok) throw fail();
    const response = ok({ redirectTo: '/mypage' });
    for (const cookie of result.headers.getSetCookie())
      response.headers.append('set-cookie', cookie);
    return response;
  }
});
