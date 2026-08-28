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
import type { SupabaseClient } from '@supabase/supabase-js';

import { unauthenticated } from '@/lib/errors';
import { verifyInternalCronSecret } from '@/lib/supabase/admin';

/** 6-12 表6-12 の「処理名」。batch_runs.job_type の CHECK と一致させる。 */
export type BatchJobType =
  | 'risk_recalculate'
  | 'notifications_dispatch'
  | 'ai_job_reclaim'
  | 'case_purge'
  | 'health_check'
  | 'usage_rollup'
  | 'backup'
  | 'rate_limit_cleanup';

/** 内部呼び出しであることを検証する。ユーザーのセッションでは通さない。 */
export function requireInternalCall(request: Request): void {
  const header = request.headers.get('x-internal-cron-secret');
  if (!verifyInternalCronSecret(header)) {
    throw unauthenticated('内部呼び出しの認証に失敗しました');
  }
}

export interface BatchOutcome {
  targetCount: number;
  detail?: Record<string, unknown>;
}

/**
 * 実行記録つきでバッチを走らせる（6-12）。
 *
 * 記録は成功・失敗のどちらでも残す。失敗だけ記録しないと
 * 「動いていないのか、動いて0件なのか」が S03 から区別できない。
 */
export async function runBatch(
  admin: SupabaseClient,
  jobType: BatchJobType,
  fn: () => Promise<BatchOutcome>,
): Promise<BatchOutcome> {
  const startedAt = new Date().toISOString();
  const started = await admin
    .from('batch_runs')
    .insert({ job_type: jobType, started_at: startedAt })
    .select('id')
    .single();
  const runId = started.data ? (started.data as { id: string }).id : null;

  const finish = async (patch: Record<string, unknown>) => {
    if (!runId) return;
    await admin.from('batch_runs').update({
      finished_at: new Date().toISOString(),
      ...patch,
    }).eq('id', runId);
  };

  try {
    const outcome = await fn();
    await finish({
      target_count: outcome.targetCount,
      http_status: 200,
      detail: outcome.detail ?? {},
    });
    return outcome;
  } catch (error) {
    await finish({
      http_status: 500,
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * venue_id → case_id の順に、進行中の案件を辿る（6-12 の「対象範囲（ループ単位）」）。
 *
 * アーカイブ済みは対象外。Service Role は RLS をバイパスするため、
 * 絞り込みはここで明示的に書く必要がある。
 */
export async function forEachActiveCase(
  admin: SupabaseClient,
  handler: (caseId: string, venueId: string) => Promise<void>,
): Promise<number> {
  const venues = await admin.from('venues').select('id').eq('active', true);
  if (venues.error) throw new Error(venues.error.message);

  let processed = 0;
  for (const venue of (venues.data ?? []) as { id: string }[]) {
    const cases = await admin
      .from('wedding_cases')
      .select('id')
      .eq('venue_id', venue.id)
      .is('archived_at', null)
      .in('status', ['draft', 'active']);
    if (cases.error) throw new Error(cases.error.message);

    for (const row of (cases.data ?? []) as { id: string }[]) {
      await handler(row.id, venue.id);
      processed += 1;
    }
  }
  return processed;
}
