/**
 * LINE Messaging API の署名検証とアカウント連携（Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-10「LINE連携設計」。
 *
 *   「署名検証は x-line-signature を raw body（Next.js のボディパースを通す前の生データ）に
 *     対して行い、定数時間比較する」
 *   「紐付け方式は LINE のアカウント連携（linkToken）方式に確定する」
 *   「『直近の招待や登録者に当てる』ような推測による紐付けは行わない」
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** nonce の有効期限。LINE の linkToken 自体が10分程度で失効するため、それに合わせる。 */
export const LINE_NONCE_TTL_SECONDS = 10 * 60;

/**
 * Webhook の署名を検証する（6-10）。
 *
 * 本文の**バイト列そのもの**に対して HMAC-SHA256 を計算する。
 * JSON.parse を通した後の値から再構築すると、キーの順序や空白が変わって必ず落ちる。
 * 比較は定数時間で行う（長さが違う場合は先に false を返す）。
 */
export function verifyLineSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** nonce は推測されると他人のアカウントへ紐付けられるため、招待トークンと同じ強度で作る。 */
export function generateLinkNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** DB へは平文を保存しない（6-3-6 と同じ方針）。 */
export function hashLinkNonce(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

/**
 * LINE のアカウント連携ダイアログURL。
 * ここへ遷移させると、LINE 側が accountLink イベントを nonce 付きで返してくる。
 */
export function accountLinkUrl(linkToken: string, nonce: string): string {
  const params = new URLSearchParams({ linkToken, nonce });
  return `https://access.line.me/dialog/bot/accountLink?${params.toString()}`;
}

export interface LineEvent {
  type: string;
  webhookEventId?: string;
  source?: { userId?: string; type?: string };
  replyToken?: string;
  link?: { result: string; nonce: string };
  message?: { type: string; text?: string };
}

/** 友だち追加のあとに送る案内。連携画面（M06）へ誘導する（6-10 手順(2)）。 */
export function buildFollowReply(linkPageUrl: string): string {
  return [
    '友だち追加ありがとうございます。',
    'マイページと連携すると、大切なお知らせをこちらでお受け取りいただけます。',
    '',
    linkPageUrl,
    '',
    '※連携は任意です。連携しない場合はメールでお送りします。',
  ].join('\n');
}

/** 返信（reply API）。失敗しても Webhook 自体は 200 で返す（LINE の再送を招かないため）。 */
export async function replyLineMessage(replyToken: string, text: string): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return false;

  try {
    const response = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    });
    if (!response.ok) console.error('[line] reply failed', response.status);
    return response.ok;
  } catch (error) {
    console.error('[line] reply threw', error);
    return false;
  }
}

/** linkToken を発行する（6-10 手順(2)）。userId は follow イベントから得たもの。 */
export async function issueLinkToken(lineUserId: string): Promise<string | null> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return null;

  try {
    const response = await fetch(
      `https://api.line.me/v2/bot/user/${encodeURIComponent(lineUserId)}/linkToken`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      console.error('[line] linkToken failed', response.status);
      return null;
    }
    const json = (await response.json()) as { linkToken?: string };
    return json.linkToken ?? null;
  } catch (error) {
    console.error('[line] linkToken threw', error);
    return null;
  }
}
