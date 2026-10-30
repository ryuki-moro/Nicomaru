import type { D1Database } from '@cloudflare/workers-types';
import { decryptPii, encryptPii } from '@/lib/crypto';
import { forbidden } from '@/lib/errors';
import { sendMail, type SendResult } from '@/lib/notify/mailer';
import { localD1 } from './mode';

export interface LocalMail {
  kind: 'otp' | 'invitation' | 'notification';
  email: string | null;
  code?: string;
  url?: string;
  channel?: string;
  expiresAt?: string;
  subject?: string;
  text?: string;
}
export async function captureMail(db: D1Database, mail: LocalMail) {
  await db
    .prepare('INSERT INTO local_mailbox(id,payload,created_at) VALUES (?,?,?)')
    .bind(crypto.randomUUID(), encryptPii(JSON.stringify(mail)), new Date().toISOString())
    .run();
}
export const LOCAL_CAPTURED = '外部送信なし。ローカル受信箱に保存しました';

/** 本番D1はメールを外部送信し、ローカル検証は受信箱へ保存する。 */
export async function deliverMail(
  db: D1Database,
  mail: LocalMail & { email: string; subject: string; text: string },
): Promise<SendResult> {
  if (!localD1()) return sendMail({ to: mail.email, subject: mail.subject, text: mail.text });
  // OTPの受信箱には本文を重ねて保存しない（コードは code で表示する）。
  const { subject, text, ...rest } = mail;
  await captureMail(db, mail.kind === 'otp' ? rest : { ...rest, subject, text });
  return { delivered: false, reason: 'not_configured', skippedReason: LOCAL_CAPTURED };
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
