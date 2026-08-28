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
import { AI_JOB_COLUMNS, type AiJobRow } from '@/lib/ai/assist';
import { validateAiOutput } from '@/lib/ai/schemas';
import { requireStaff } from '@/lib/auth/session';
import { badRequest, conflict, fromPostgresError, notFound } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { aiJobReviewSchema } from '@/lib/validation';

export const runtime = 'nodejs';

export const GET = route(
  async (_request: Request, context: { params: Promise<{ jobId: string }> }) => {
    await requireStaff();
    const { jobId } = await context.params;

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from('ai_jobs')
      .select(`${AI_JOB_COLUMNS}, model_name, started_at`)
      .eq('id', jobId)
      .maybeSingle();
    if (error) throw fromPostgresError(error);
    if (!data) throw notFound('ジョブが見つかりません');

    return ok(data);
  },
);

export const PATCH = route(
  async (request: Request, context: { params: Promise<{ jobId: string }> }) => {
    await requireStaff();
    const { jobId } = await context.params;
    const input = await parseBody(request, aiJobReviewSchema);

    const supabase = await createSupabaseServerClient();

    // 修正して採用する場合（7-2 の 9-1「プランナーが修正できる」）は、
    // 保存前に job_type のスキーマを通す。
    // AI の生出力は検証済みでも、画面から来た修正内容は未検証のため。
    let revised: unknown = null;
    if (input.output !== undefined) {
      if (input.decision !== 'confirmed') {
        throw badRequest([{ field: 'output', reason: '破棄する場合は内容を送れません' }]);
      }
      const target = await supabase
        .from('ai_jobs')
        .select('id, job_type')
        .eq('id', jobId)
        .maybeSingle();
      if (target.error) throw fromPostgresError(target.error);
      if (!target.data) throw notFound('ジョブが見つかりません');

      const jobType = (target.data as Pick<AiJobRow, 'job_type'>).job_type;
      const validated = validateAiOutput(jobType, input.output);
      if (!validated.ok) {
        throw badRequest([{ field: 'output', reason: validated.error }]);
      }
      revised = validated.value;
    }

    const { data, error } = await supabase.rpc('review_ai_job', {
      p_job_id: jobId,
      p_decision: input.decision,
      p_output: revised,
    });
    if (error) throw fromPostgresError(error);

    // done でないジョブは採用できない（生成前の出力を採用してしまわないように）
    if (data !== true) {
      throw conflict('このジョブはまだ確認できる状態ではありません');
    }

    return ok({ id: jobId, status: input.decision });
  },
);
