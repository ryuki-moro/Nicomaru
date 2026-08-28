/**
 * Service Role Key を使うクライアント。RLS をバイパスするため使用箇所を厳密に限定する。
 *
 * 正本: 基本設計書 Version 1.2 6-3-5「Service Role Key の使用範囲」表6-4。
 * 12-2 の開発標準により、使用範囲表にない新規使用は表の更新を伴わない限り却下する。
 *
 * 呼び出し側は必ず {@link ServiceRoleUseCase} のいずれかを指定する。
 * これにより「どの行で許可された使用なのか」がコード上で追跡でき、
 * AI がRLSエラー回避のために Service Role へ逃げる典型的な失敗をレビューで機械的に検出できる。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** 表6-4 に列挙された使用箇所と、そのときAPI層で担保すべき権限検証。 */
export const SERVICE_ROLE_USE_CASES = {
  'auth.initial-register':
    'case_invitations の token_hash 照合と expires_at／used_at／revoked_at／purpose／max_uses チェックを必須実施。'
    + 'recipient_email が設定された招待は入力メールとの一致も必須。検証と消費は単一 UPDATE ... RETURNING（6-6-1）',
  'auth.rate-limit':
    'auth_rate_limits は authenticated から直接参照させないため、判定関数の呼び出しにのみ用いる（付録A）',
  'admin.users':
    '呼び出し元JWTの role が admin／system_admin であることを検証。venue_id は呼び出し元の値に固定し、'
    + 'role は U02 の自動設定規則に従う（任意指定を受け付けない）',
  'admin.venues':
    "呼び出し元JWTの role が system_admin であることを検証。作成する role は 'admin' に固定する",
  'audit.auth-event':
    '未ログイン時の認証イベントのみ。actor_user_id は NULL とし、任意の action／target を外部から指定させない',
  'cron.risk-recalculate':
    '内部呼び出し認証（INTERNAL_CRON_SECRET）で起動元を検証。venue_id／case_id 単位でループする',
  'cron.notifications-dispatch':
    '内部呼び出し認証（INTERNAL_CRON_SECRET）で起動元を検証。venue_id／case_id 単位でループする',
  'cron.case-purge':
    '内部呼び出し認証（INTERNAL_CRON_SECRET）で起動元を検証。'
    + 'archived_at が保持期間を超えた案件のみを対象とし、対象外の案件には触れない（6-11）',
  'cron.ai-job-reclaim':
    '内部呼び出し認証（INTERNAL_CRON_SECRET）で起動元を検証。'
    + '滞留ジョブの回収と、保持期間を過ぎたAIジョブ入出力の削除にのみ用いる（7-3／7-4）',
  'line.link':
    'LINE連携の nonce 発行。呼び出し元JWTの role が couple であることを検証し、'
    + '自案件に限る。平文の nonce は応答でのみ返し保存しない（6-10）',
  'line.webhook':
    'LINE からの Webhook。署名検証（raw body）を通過したリクエストのみ。'
    + '受信イベントIDの重複排除と、連携完了の書き込みに限る（6-10）',
} as const;

export type ServiceRoleUseCase = keyof typeof SERVICE_ROLE_USE_CASES;

let cached: SupabaseClient | null = null;

/**
 * @param useCase 表6-4 のどの行にあたる使用かを明示する。
 */
export function createSupabaseAdminClient(useCase: ServiceRoleUseCase): SupabaseClient {
  if (!(useCase in SERVICE_ROLE_USE_CASES)) {
    throw new Error(
      `Service Role の使用範囲表（6-3-5 表6-4）にない用途です: ${useCase}。`
      + '新規使用は設計書の表を更新したうえで本モジュールへ追加すること。',
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL が設定されていません');
  }

  cached ??= createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}

/** 内部呼び出し（定期処理）の共有シークレット検証（6-5-2）。 */
export function verifyInternalCronSecret(headerValue: string | null): boolean {
  const expected = process.env.INTERNAL_CRON_SECRET;
  if (!expected || !headerValue) return false;
  // 長さが違えば即座に false。同じなら定数時間で比較する。
  if (headerValue.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= headerValue.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
