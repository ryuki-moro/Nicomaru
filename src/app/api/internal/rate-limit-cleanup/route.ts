/**
 * POST /api/internal/rate-limit-cleanup — 古いレート制限ウィンドウの削除（6-12、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-12 表6-12。
 *
 *   契機・頻度   : 日次
 *   対象範囲     : 全件（保持は7日）
 *   失敗時の扱い : 自動リトライなし
 *   失敗の検知先 : 実行記録
 *
 * auth_rate_limits はウィンドウごとに行が増える表なので、掃除しないと際限なく肥大する。
 * 無料枠（Supabase Free）のDB容量を守るための処理でもある（8-3）。
 * あわせて通知の送信上限カウンタも同じ考え方で古い窓を落とす。
 */
import { ok, route } from '@/lib/api/route';
import { requireInternalCall, runBatch } from '@/lib/api/internal';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

/** 6-12「保持は7日」。 */
const RETENTION_DAYS = 7;
/** 送信上限カウンタは月枠を見るため、月をまたいで参照されうる。2か月ぶんは残す。 */
const QUOTA_RETENTION_DAYS = 62;

export const POST = route(async (request: Request) => {
  requireInternalCall(request);

  const admin = createSupabaseAdminClient('auth.rate-limit');
  const day = 24 * 60 * 60 * 1000;

  const outcome = await runBatch(admin, 'rate_limit_cleanup', async () => {
    const rateCutoff = new Date(Date.now() - RETENTION_DAYS * day).toISOString();
    const rate = await admin
      .from('auth_rate_limits')
      .delete()
      .lt('window_start', rateCutoff)
      .select('id');
    if (rate.error) throw new Error(rate.error.message);

    const quotaCutoff = new Date(Date.now() - QUOTA_RETENTION_DAYS * day)
      .toISOString().slice(0, 10);
    const quota = await admin
      .from('notification_quota_counters')
      .delete()
      .lt('window_start', quotaCutoff)
      .select('id');
    if (quota.error) throw new Error(quota.error.message);

    const removed = (rate.data ?? []).length + (quota.data ?? []).length;
    return {
      targetCount: removed,
      detail: {
        authRateLimits: (rate.data ?? []).length,
        notificationQuota: (quota.data ?? []).length,
      },
    };
  });

  return ok({ removed: outcome.targetCount });
});
