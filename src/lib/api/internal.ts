/**
 * 内部呼び出し（定期処理）の共通処理。
 *
 * 正本: 基本設計書 Version 1.2 6-5-2「内部呼び出し（定期処理）の認証」／6-12。
 *
 *   - 共有シークレット（INTERNAL_CRON_SECRET）をヘッダーに付与し API が検証する。
 *     ユーザー向けJWT検証とは別経路に分離する。
 *   - 対象範囲は「全件」ではなく venue_id／case_id 単位でループし、
 *     任意のIDを外部から指定させない。
 *   - pg_net は fire-and-forget のため、各処理は実行記録を残す（6-12）。
 *     この記録が無いと失敗を検知できない。
 */

import { safeEqual } from '@/lib/crypto';
import { unauthenticated } from '@/lib/errors';

/** 6-12 表6-12 の「処理名」。batch_runs.job_type の CHECK と一致させる。 */
export type BatchJobType =
  | 'risk_recalculate'
  | 'notifications_dispatch'
  | 'ai_job_reclaim'
  | 'case_purge'
  | 'health_check'
  | 'usage_rollup'
  | 'monitoring'
  | 'audit_log_purge'
  | 'backup'
  | 'rate_limit_cleanup';

/** 内部呼び出しであることを検証する。ユーザーのセッションでは通さない。 */
export function requireInternalCall(request: Request): void {
  const header = request.headers.get('x-internal-cron-secret');
  if (!verifyInternalCronSecret(header)) {
    throw unauthenticated('内部呼び出しの認証に失敗しました');
  }
}

/**
 * ローカルLLMワーカーの認証（7-3）。D1にはDBロールが無いため、DB接続情報の代わりに
 * 「ジョブ取得・結果書込み・心拍」しかできない共有トークンを配る。短いトークンは受け付けない。
 */
export function requireAiWorkerCall(request: Request): void {
  const expected = process.env.AI_WORKER_TOKEN ?? '';
  const header = request.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (expected.length < 32 || !safeEqual(given, expected)) {
    throw unauthenticated('ワーカーの認証に失敗しました');
  }
}

export interface BatchOutcome {
  targetCount: number;
  detail?: Record<string, unknown>;
}

/** 部分的に完了した処理を、成功件数を失わず失敗として記録する。 */
export class BatchFailure extends Error {
  constructor(
    message: string,
    readonly outcome: BatchOutcome,
  ) {
    super(message);
    this.name = 'BatchFailure';
  }
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
