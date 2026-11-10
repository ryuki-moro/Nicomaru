import { ok, route } from '@/lib/api/route';
/** 2暦年を超えた監査ログだけを削除する。案件/通知ログの保持処理とは独立する。 */
export const POST = route(
  async () => {
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { runBatchD1 } = await import('@/lib/d1/batches');
      const db = await localDB();
      const outcome = await runBatchD1(db, 'audit_log_purge', async () => {
        // D1 の created_at は CURRENT_TIMESTAMP (UTC) 形式なので SQLite の datetime で揃える。
        const cutoffRow = await db.prepare("SELECT datetime('now','-2 years') AS cutoff").first<{
          cutoff: string;
        }>();
        const cutoff = cutoffRow?.cutoff;
        if (!cutoff) throw new Error('監査ログの保持期限処理の結果を確認できませんでした');
        const counted = await db
          .prepare('SELECT count(*) AS n FROM audit_logs WHERE created_at<?')
          .bind(cutoff)
          .first<{
            n: number;
          }>();
        const deleted = counted?.n ?? 0;
        if (deleted > 0)
          await db.prepare('DELETE FROM audit_logs WHERE created_at<?').bind(cutoff).run();
        return { targetCount: deleted, detail: { retentionYears: 2, cutoff } };
      });
      return ok({ removed: outcome.targetCount });
    }
  },
  { source: 'internal-cron' },
);
