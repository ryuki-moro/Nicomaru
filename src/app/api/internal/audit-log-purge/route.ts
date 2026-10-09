import { runBatch } from '@/lib/api/internal';
import { ok, route } from '@/lib/api/route';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/** 2暦年を超えた監査ログだけを削除する。案件/通知ログの保持処理とは独立する。 */
export const POST = route(
  async () => {
    const admin = createSupabaseAdminClient('cron.audit-log-purge');
    const outcome = await runBatch(admin, 'audit_log_purge', async () => {
      const result = await admin.rpc('purge_expired_audit_logs');
      if (result.error || !Array.isArray(result.data) || result.data.length !== 1) {
        throw new Error('監査ログの保持期限処理に失敗しました');
      }
      const row = result.data[0] as { deleted_count: number; cutoff: string };
      if (!Number.isSafeInteger(row.deleted_count) || row.deleted_count < 0 || !row.cutoff) {
        throw new Error('監査ログの保持期限処理の結果を確認できませんでした');
      }
      return { targetCount: row.deleted_count, detail: { retentionYears: 2, cutoff: row.cutoff } };
    });
    return ok({ removed: outcome.targetCount });
  },
  { source: 'internal-cron' },
);
