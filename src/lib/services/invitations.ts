/**
 * 招待トークンの発行・照合・状態判定。
 *
 * 正本: 基本設計書 Version 1.2 6-3-6「招待トークンの保存方式」／6-6-1「初回登録フロー」／13-1。
 *
 * 設計上の要点:
 *   - 平文トークンはDBに保存しない。保存するのは SHA-256 ハッシュのみ。
 *     したがって既発行の招待URLを後から表示・再送することはできず、
 *     送信・URL再表示は必ず再発行（既存を revoked_at で失効 → 新規行）を伴う（K02）。
 *   - 検証とトークン消費は単一の UPDATE ... WHERE ... RETURNING で原子的に行う。
 *   - recipient_email が設定されていれば、入力メールの HMAC との一致を登録の必須条件とする。
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  INVITATION_MAX_USES,
  INVITATION_TTL_DAYS,
  type InvitationPurpose,
  type InvitationState,
} from '@/lib/constants';

/** URL に載るトークン。推測不能な 256bit 乱数を base64url で表現する。 */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** DB へ保存するハッシュ。照合時は受け取った平文を同じ関数に通して比較する（6-3-6）。 */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function invitationExpiresAt(purpose: InvitationPurpose, now: Date = new Date()): Date {
  const expires = new Date(now.getTime());
  expires.setUTCDate(expires.getUTCDate() + INVITATION_TTL_DAYS[purpose]);
  return expires;
}

export function invitationMaxUses(purpose: InvitationPurpose): number {
  return INVITATION_MAX_USES[purpose];
}

export function buildInvitationUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/register/${token}`;
}

export interface InvitationRow {
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  use_count: number;
  max_uses: number;
}

/** K02 の招待状況セクションに表示する状態（4-3 K02）。 */
export function invitationState(row: InvitationRow, now: Date = new Date()): InvitationState {
  if (row.revoked_at !== null) return 'revoked';
  if (row.used_at !== null || row.use_count >= row.max_uses) return 'used';
  if (new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'unused';
}

/**
 * トークンの原子的な消費（6-6-1）。
 *
 * 実体は security definer 関数 consume_invitation(token_hash, purpose)
 * （supabase/migrations/20260828000700_auth_functions.sql）。SQL の正本はそちらに1本だけ置く。
 * 単一の UPDATE ... WHERE ... RETURNING で「検証」と「消費」を同時に行うため、
 * 同一URLへの同時2リクエストでも1つしか通らない。0行なら 422 を返す。
 *
 * 関数が検証する条件:
 *   - token_hash が一致する
 *   - purpose が一致する（max_uses>1 の mypage_access を初回登録へ流用させない）
 *   - used_at が NULL（未使用）
 *   - revoked_at が NULL（再発行で失効していない）
 *   - expires_at > now()（期限内）
 *   - use_count < max_uses（回数上限内）
 *
 * 失敗時の補償は restore_invitation(id)。自動リトライは行わない。
 */

/**
 * 招待先メールとの照合（6-6-1／13-1）。
 * recipient_email_hash が NULL の招待（LINE案内のみ）は、確認コード検証を経るまで案件へ紐付けない。
 */
export type EmailMatchResult = 'match' | 'mismatch' | 'requires_verification';

export function matchRecipientEmail(
  recipientEmailHash: string | null,
  inputEmailHash: string,
): EmailMatchResult {
  if (recipientEmailHash === null) return 'requires_verification';
  return recipientEmailHash === inputEmailHash ? 'match' : 'mismatch';
}
