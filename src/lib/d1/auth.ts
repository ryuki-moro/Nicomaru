import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins';
import type { D1Database } from '@cloudflare/workers-types';
import { headers } from 'next/headers';
import { OTP, PASSWORD_MIN_LENGTH } from '@/lib/constants';
import { hmacHash } from '@/lib/crypto';
import type { ResolvedUser, AppUser } from '@/lib/auth/session';
import { localDB } from './runtime';
import { deliverMail } from './mailbox';

/** トークンはフラグメントに置き、サーバーのアクセスログとReferer に残さない。 */
export const passwordLink = (mode: 'reset' | 'invite', token: string) =>
  `${process.env.APP_BASE_URL}/password?mode=${mode}#token=${encodeURIComponent(token)}`;

export async function d1Auth() {
  return createD1Auth(await localDB());
}
/** メールアドレス＋パスワードで認証する。成功時の応答は Set-Cookie を持つ。 */
export async function signInD1WithPassword(email: string, password: string, ip: string) {
  return (await d1Auth()).handler(
    new Request(new URL('/api/auth/sign-in/email', process.env.APP_BASE_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: process.env.APP_BASE_URL!,
        'x-nicomaru-local-ip': ip,
      },
      body: JSON.stringify({ email, password }),
    }),
  );
}

export function createD1Auth(db: D1Database) {
  return betterAuth({
    database: db,
    baseURL: process.env.APP_BASE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3600,
      // 再設定と初回設定は同じトークン形式。初回設定のトークンは staff.ts が72時間で発行する。
      sendResetPassword: async ({ user, token }) => {
        const result = await deliverMail(db, {
          kind: 'password',
          email: user.email,
          url: passwordLink('reset', token),
          subject: '【にこまる】パスワード再設定のご案内',
          text: `${user.name} 様

下のリンクから新しいパスワードを設定してください。

${passwordLink('reset', token)}

・リンクの有効期限は1時間です。
・お心当たりのない場合は、このメールを破棄してください。パスワードは変わりません。`,
        });
        if (!result.delivered && result.reason === 'provider_error')
          console.error('[d1-auth] パスワード再設定メールの送信に失敗しました');
      },
    },
    plugins: [
      emailOTP({
        otpLength: OTP.length,
        expiresIn: OTP.ttlSeconds,
        allowedAttempts: OTP.verifyFailuresBeforeInvalidation,
        disableSignUp: true,
        storeOTP: { hash: async (code) => hmacHash(`otp:${code}`) },
        sendVerificationOTP: async ({ email, otp }) => {
          const minutes = Math.round(OTP.ttlSeconds / 60);
          const result = await deliverMail(db, {
            kind: 'otp',
            email,
            code: otp,
            expiresAt: new Date(Date.now() + OTP.ttlSeconds * 1000).toISOString(),
            subject: 'ログイン確認コード（にこまる）',
            text: `ログイン確認コード: ${otp}

このコードの有効期限は${minutes}分です。
お心当たりがない場合は、このメールを破棄してください。`,
          });
          // 登録の有無を応答で区別させないため、送信失敗も例外にせず記録だけ残す。
          if (!result.delivered && result.reason === 'provider_error')
            console.error('[d1-auth] 確認コードのメール送信に失敗しました');
        },
      }),
    ],
    session: { expiresIn: 3600, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        // 公開API側でメール別・IP別の永続制限を先に適用する。
        '/email-otp/send-verification-otp': false,
        '/sign-in/email-otp': false,
      },
    },
    advanced: { ipAddress: { ipAddressHeaders: ['x-nicomaru-local-ip'] } },
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            const profile = await db
              .prepare('SELECT status,role FROM user_profiles WHERE id=?')
              .bind(session.userId)
              .first<{ status: string; role: string }>();
            if (profile?.status !== 'active') throw new APIError('FORBIDDEN');
            if (context?.path === '/sign-in/email-otp' && profile.role !== 'couple')
              throw new APIError('FORBIDDEN');
            return { data: session };
          },
        },
      },
    },
  });
}

export async function resolveD1User(): Promise<ResolvedUser> {
  // 先にheaders()を読み、静的生成時はDBへ接続する前に動的描画へ切り替える。
  const requestHeaders = await headers();
  const session = await (await d1Auth()).api.getSession({ headers: requestHeaders });
  if (!session) return { state: 'anonymous' };
  const row = await (
    await localDB()
  )
    .prepare('SELECT role,venue_id,status FROM user_profiles WHERE id=?')
    .bind(session.user.id)
    .first<{ role: AppUser['role']; venue_id: string | null; status: string }>();
  if (!row || row.status !== 'active') return { state: 'inactive' };
  return {
    state: 'active',
    user: {
      id: session.user.id,
      authUserId: session.user.id,
      role: row.role,
      venueId: row.venue_id,
      displayName: session.user.name,
      email: session.user.email,
    },
  };
}
