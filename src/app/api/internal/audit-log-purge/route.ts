import { runBatch } from '@/lib/api/internal';
import { ok, route } from '@/lib/api/route';
import { usingD1 } from '@/lib/d1/mode';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/** 2暦年を超えた監査ログだけを削除する。案件/通知ログの保持処理とは独立する。 */
export const POST = route(
  async () => {
    if (usingD1()) {
      const { localDB } = await import('@/lib/d1/runtime');
      const { runBatchD1 } = await import('@/lib/d1/batches');
      const db = await localDB();
      const outcome = await runBatchD1(db, 'audit_log_purge', async () => {
        // Supabase 版 purge_expired_audit_logs と同じく UTC 暦で2年引き、閾値と等しい行は保持。
        // D1 の created_at は CURRENT_TIMESTAMP (UTC) 形式なので SQLite の datetime で揃える。
        const cutoffRow = await db
          .prepare("SELECT datetime('now','-2 years') AS cutoff")
          .first<{ cutoff: string }>();
        const cutoff = cutoffRow?.cutoff;
        if (!cutoff) throw new Error('監査ログの保持期限処理の結果を確認できませんでした');
        const counted = await db
          .prepare('SELECT count(*) AS n FROM audit_logs WHERE created_at<?')
          .bind(cutoff)
          .first<{ n: number }>();
        const deleted = counted?.n ?? 0;
        if (deleted > 0)
          await db.prepare('DELETE FROM audit_logs WHERE created_at<?').bind(cutoff).run();
        return { targetCount: deleted, detail: { retentionYears: 2, cutoff } };
      });
      return ok({ removed: outcome.targetCount });
    }

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
