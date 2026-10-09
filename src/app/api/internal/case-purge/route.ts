/**
 * POST /api/internal/case-purge — 案件終了後の自動削除・匿名化（6-12、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-11／6-12 表6-12／13-1。
 *
 *   契機・頻度   : 日次
 *   対象範囲     : archived_at が保持期間を超過した案件。
 *                  DBレコードの削除・匿名化と Storage 実体の削除
 *   失敗時の扱い : 自動リトライなし。件数を実行記録に残す
 *   失敗の検知先 : 実行記録・監査（9-1）
 *
 * 保持期間は 13-1 の開発チーム決定により **archived_at から180日**。
 * 監査ログ（audit_logs）と通知送信ログ（notification_logs）は
 * 「別途の保持期間ポリシーに従い自動削除の対象外」（6-11）なので触らない。
 *
 * AIジョブ（ai_jobs）はこれとは別の保持期間を持つ（7-4／13-1）。
 * 入出力は完了から30日、行は作成から90日。案件の終了を待たない。
 * 個人情報を含みうる入出力を、案件が終わるまで持ち続ける理由が無いため
 * （20260828001900_ai_job_retention.sql）。日次の処理はここに相乗りする。
 *
 * 【匿名化ではなく削除にしている範囲】
 * 6-11 は「個人情報・ゲスト情報・提出ファイルを自動削除対象とする」と定める。
 * 案件そのものの行は残す（案件番号・挙式日は式場の実績として意味があり、
 * 消すと audit_logs から辿れなくなる）。個人が特定できる列だけを落とす。
 */
import { ok, route } from '@/lib/api/route';
import { runBatch } from '@/lib/api/internal';
import { purgeCases } from '@/lib/batches/case-purge';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

// 内部呼び出しはOriginではなく、共通wrapperで共有シークレットを検証する。
export const POST = route(
  async () => {
    const admin = createSupabaseAdminClient('cron.case-purge');
    const outcome = await runBatch(admin, 'case_purge', () => purgeCases(admin));
    return ok({
      purged: outcome.targetCount,
      filesRemoved: outcome.detail?.filesRemoved,
      aiPayloadsCleared: outcome.detail?.aiPayloadsCleared,
      aiRowsDeleted: outcome.detail?.aiRowsDeleted,
    });
  },
  { source: 'internal-cron' },
);
