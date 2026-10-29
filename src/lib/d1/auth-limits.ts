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
) {
  const normalized = normalizeEmail(email);
  const max = { otp_request: 5, otp_verify: 20, initial_register: 10 }[operation];
  await limit(db, `${operation}:local-ip`, operation === 'otp_verify' ? 200 : 100, 3600);
  await limit(db, `${operation}:${normalized}`, max, 3600);
  if (operation === 'otp_request') await limit(db, `otp_resend:${normalized}`, 1, 60);
}
