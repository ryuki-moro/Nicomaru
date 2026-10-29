import type { D1Database } from '@cloudflare/workers-types';
import { decryptPii, encryptPii } from '@/lib/crypto';
import { forbidden } from '@/lib/errors';

export interface LocalMail {
  kind: 'otp' | 'invitation';
  email: string | null;
  code?: string;
  url?: string;
  channel?: string;
  expiresAt?: string;
}
export async function captureMail(db: D1Database, mail: LocalMail) {
  await db
    .prepare('INSERT INTO local_mailbox(id,payload,created_at) VALUES (?,?,?)')
    .bind(crypto.randomUUID(), encryptPii(JSON.stringify(mail)), new Date().toISOString())
    .run();
}
export async function readMailbox(db: D1Database) {
  const result = await db
    .prepare(
      'SELECT id,payload,created_at FROM local_mailbox ORDER BY created_at DESC,rowid DESC LIMIT 50',
    )
    .all<{ id: string; payload: string; created_at: string }>();
  return result.results.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    ...(JSON.parse(decryptPii(row.payload)!) as LocalMail),
  }));
}
export function requireLocalMailbox(requestHeaders: Headers) {
  const site = requestHeaders.get('sec-fetch-site');
  if (
    process.env.NICOMARU_DB !== 'd1-local' ||
    process.env.NODE_ENV !== 'development' ||
    process.env.APP_BASE_URL !== 'http://127.0.0.1:3104' ||
    requestHeaders.get('host') !== '127.0.0.1:3104' ||
    (site && !['same-origin', 'none'].includes(site)) ||
    (requestHeaders.has('origin') && requestHeaders.get('origin') !== process.env.APP_BASE_URL)
  )
    throw forbidden();
}
