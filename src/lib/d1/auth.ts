import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins';
import type { D1Database } from '@cloudflare/workers-types';
import { headers } from 'next/headers';
import { OTP } from '@/lib/constants';
import { hmacHash } from '@/lib/crypto';
import type { ResolvedUser, AppUser } from '@/lib/auth/session';
import { localDB } from './runtime';
import { captureMail } from './mailbox';

export async function d1Auth() {
  return createD1Auth(await localDB());
}
export function createD1Auth(db: D1Database) {
  return betterAuth({
    database: db,
    baseURL: process.env.APP_BASE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    emailAndPassword: { enabled: true, disableSignUp: true },
    plugins: [
      emailOTP({
        otpLength: OTP.length,
        expiresIn: OTP.ttlSeconds,
        allowedAttempts: OTP.verifyFailuresBeforeInvalidation,
        disableSignUp: true,
        storeOTP: { hash: async (code) => hmacHash(`otp:${code}`) },
        sendVerificationOTP: async ({ email, otp }) =>
          captureMail(db, {
            kind: 'otp',
            email,
            code: otp,
            expiresAt: new Date(Date.now() + OTP.ttlSeconds * 1000).toISOString(),
          }),
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
  const session = await (await d1Auth()).api.getSession({ headers: await headers() });
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
