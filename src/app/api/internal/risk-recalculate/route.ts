/**
 * POST /api/internal/risk-recalculate — リスク再計算の定期処理（6-12、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-12「バッチ・定期処理一覧」／6-5-2／表6-4。
 *
 *   契機・頻度       : 日次（深夜）＋提出・確認時のイベント
 *   対象範囲         : venue_id → case_id
 *   失敗時の扱い     : 自動リトライなし。次回実行で回復
 *   失敗の検知先     : 実行記録（batch_runs）・S03・10章のアラート
 *
 * pg_cron から pg_net 経由で叩かれる。pg_net は fire-and-forget なので、
 * 成否は batch_runs にしか残らない。
 *
 * 1案件が落ちても全体を止めない。設計が「次回実行で回復」としているのは、
 * 1件の不整合で当日のリスク表示が丸ごと止まる方が運用上の損失が大きいため。
 */
import { ok, route } from '@/lib/api/route';
import { forEachActiveCase, requireInternalCall, runBatch } from '@/lib/api/internal';
import { persistViaServiceRole, recalculateCaseRisk } from '@/lib/services/riskStore';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

export const POST = route(async (request: Request) => {
  requireInternalCall(request);

  // 表6-4「/api/cases/{caseId}/risk/recalculate（定期処理）｜使用する（内部バッチ）」
  const admin = createSupabaseAdminClient('cron.risk-recalculate');

  const failures: { caseId: string; message: string }[] = [];

  const outcome = await runBatch(admin, 'risk_recalculate', async () => {
    const processed = await forEachActiveCase(admin, async (caseId) => {
      try {
        await recalculateCaseRisk(admin, caseId, persistViaServiceRole(admin, caseId));
      } catch (error) {
        // 自動リトライはしない（6-12）。件数と理由だけ残して次の案件へ進む。
        failures.push({
          caseId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return {
      targetCount: processed,
      detail: { failed: failures.length, failures: failures.slice(0, 20) },
    };
  });

  return ok({
    processed: outcome.targetCount,
    failed: failures.length,
  });
});
