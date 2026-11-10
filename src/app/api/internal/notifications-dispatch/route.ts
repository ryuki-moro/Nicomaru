/**
 * POST /api/internal/notifications-dispatch — 通知ディスパッチ（表6-6／6-12、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-12 表6-12／6-9／付録D。
 *
 *   契機・頻度   : 日次
 *   対象範囲     : venue_id → case_id。期限N日前・期限超過を抽出し notifications を作成、
 *                  queued を送信
 *   失敗時の扱い : 送信失敗は notification_logs に failure を記録し翌日再試行
 *   失敗の検知先 : notification_logs・S03
 *
 * 「翌日再試行」を成立させるため、送信に失敗した通知は status を failed にしたうえで
 * 翌日の実行で再び拾えるようにする（queued へ戻す）。
 * 二重送信を避けるため、同じ案件・同じ宿題・同じ種別の通知はその日のうちに1通しか作らない。
 */
import { ok, route } from '@/lib/api/route';
export const runtime = 'nodejs';
interface TaskRow {
  id: string;
  title: string;
  due_date: string;
  status: string;
}
// 内部呼び出しはOriginではなく、共通wrapperで共有シークレットを検証する。
export const POST = route(
  async () => {
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { runBatchD1 } = await import('@/lib/d1/batches');
      const { dispatchNotificationsD1 } = await import('@/lib/d1/notifications-dispatch');
      const db = await localDB();
      const outcome = await runBatchD1(db, 'notifications_dispatch', () =>
        dispatchNotificationsD1(db),
      );
      return ok({
        cases: outcome.targetCount,
        created: outcome.detail?.created,
        sent: outcome.detail?.sent,
        failed: outcome.detail?.failed,
      });
    }
  },
  { source: 'internal-cron' },
);
