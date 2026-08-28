/**
 * POST /api/internal/ai-job-reclaim — AIジョブの滞留回収（6-12、Phase 3）。
 *
 * 正本: 基本設計書 Version 1.2 6-12 表6-12／7-3。
 *
 *   契機・頻度   : 10分ごと
 *   対象範囲     : locked_at が閾値（例30分）を超えた processing を queued へ戻す。
 *                  attempts 上限超過で failed
 *   失敗時の扱い : attempts 上限で failed 固定
 *   失敗の検知先 : ai_jobs.status・S03
 *
 * ワーカーは校内または自宅のGPU搭載PC上で動き常時起動とは限らない（7-3）。
 * 落ちたワーカーが掴んだままのジョブを戻さないと、そのジョブは永久に processing で止まる。
 */
import { ok, route } from '@/lib/api/route';
import { requireInternalCall, runBatch } from '@/lib/api/internal';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

/** 7-3「locked_at が30分を超えた processing」「上限3回で failed」 */
const STALE_MINUTES = 30;
const MAX_ATTEMPTS = 3;

export const POST = route(async (request: Request) => {
  requireInternalCall(request);

  const admin = createSupabaseAdminClient('cron.ai-job-reclaim');

  const outcome = await runBatch(admin, 'ai_job_reclaim', async () => {
    const { data, error } = await admin.rpc('reclaim_stalled_ai_jobs', {
      p_stale_minutes: STALE_MINUTES,
      p_max_attempts: MAX_ATTEMPTS,
    });
    if (error) throw new Error(error.message);

    const row = (Array.isArray(data) ? data[0] : data) as
      { requeued: number; failed: number } | null;
    const requeued = row?.requeued ?? 0;
    const failed = row?.failed ?? 0;

    return { targetCount: requeued + failed, detail: { requeued, failed } };
  });

  return ok({ processed: outcome.targetCount, ...outcome.detail });
});
