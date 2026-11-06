/**
 * GET/PATCH /api/ai/jobs/{jobId} — ジョブ状態の取得と、結果の確認・採用（表6-6、Phase 3）。
 *
 * 正本: 基本設計書 Version 1.2 7-3／7-1。
 *
 *   「プランナーが結果を確認・採用すると status=confirmed、破棄すると discarded とする。
 *     採用後の下書きは対応する通知・宿題・準備シートに反映する」
 *
 * 7-1 の絶対原則「出力は必ずプランナーの確認を経て利用する（自動送信・自動登録は行わない）」を
 * 実装として担保しているのがこの PATCH。ここを通らない限り、
 * AI の出力が業務データへ反映されることはない。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireStaff } from '@/lib/auth/session';
import { jobRow, reviewJob } from '@/lib/d1/ai';
import { localDB } from '@/lib/d1/runtime';
import { aiJobReviewSchema } from '@/lib/validation';
export const runtime = 'nodejs';
export const GET = route(
  async (
    _request: Request,
    context: {
      params: Promise<{
        jobId: string;
      }>;
    },
  ) => {
    const user = await requireStaff();
    const { jobId } = await context.params;
    return ok(await jobRow(await localDB(), user, jobId));
  },
);
export const PATCH = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        jobId: string;
      }>;
    },
  ) => {
    const user = await requireStaff();
    const { jobId } = await context.params;
    const input = await parseBody(request, aiJobReviewSchema);
    return ok(await reviewJob(await localDB(), user, jobId, input.decision, input.output));
  },
);
