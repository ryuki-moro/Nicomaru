import type { D1Database } from '@cloudflare/workers-types';
import { hmacHash, normalizeEmail } from '@/lib/crypto';
import { rateLimited } from '@/lib/errors';

async function limit(db: D1Database, key: string, max: number, windowSeconds: number) {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO app_auth_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN window_start<=? THEN 1 ELSE count+1 END,
    window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END RETURNING count`,
    )
    .bind(hmacHash(key), now, now - windowSeconds * 1000, now - windowSeconds * 1000)
    .first<{ count: number }>();
  if (!row || row.count > max) throw rateLimited();
}
export async function authLimit(
  db: D1Database,
  operation: 'otp_request' | 'otp_verify' | 'initial_register',
  email: string,
  ip = 'local-ip',
) {
  const normalized = normalizeEmail(email);
  const max = { otp_request: 5, otp_verify: 20, initial_register: 10 }[operation];
  await limit(db, `${operation}:${ip}`, operation === 'otp_verify' ? 200 : 100, 3600);
  // 検証の上限をメール単位にすると、第三者の誤入力で本人まで締め出される。
  // 総当たりはコードごとの失効（誤り5回）と再送制限で抑える。
  const subject = operation === 'otp_verify' ? `${ip}:${normalized}` : normalized;
  await limit(db, `${operation}:${subject}`, max, 3600);
  if (operation === 'otp_request') await limit(db, `otp_resend:${normalized}`, 1, 60);
}
