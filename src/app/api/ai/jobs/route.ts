/**
 * POST/GET /api/ai/jobs — AIジョブの投入と一覧（表6-6、機能9-6、Phase 3）。
 *
 * 正本: 基本設計書 Version 1.2 7-3「ジョブキュー・処理アーキテクチャ」／7-2／7-4。
 *
 *   「プランナー操作またはイベント（提出・打ち合わせ記録登録）で /api/ai/jobs が
 *     ジョブを ai_jobs（status=queued）に投入する」
 *   「いずれの経路でも Service Role Key は使用しない（6-3-5）」
 *
 * 投入は enqueue_ai_job() 経由。venue_id を案件から引くのは、
 * 引数で受け取ると他式場のジョブを作れてしまうため。
 *
 * couple 向けの 9-7 FAQ一次回答は専用の /api/ai/faq から投入する（7-3）。
 * ここは staff 専用で、job_type にも 'faq_answer' を許さない。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireStaff } from '@/lib/auth/session';
import { AI_JOB_TYPES } from '@/lib/ai/schemas';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { fromPostgresError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { aiJobCreateSchema } from '@/lib/validation';

export const runtime = 'nodejs';

export const POST = route(async (request: Request) => {
  await requireStaff();
  const input = await parseBody(request, aiJobCreateSchema);
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('enqueue_ai_job', {
    p_case_id: input.caseId,
    p_job_type: input.jobType,
    // 7-4「LLMへの入力は最小限の項目に限定する」。本文ではなく参照を渡すのが基本
    p_input_ref: input.input,
    p_related_task_id: input.relatedTaskId ?? null,
  });
  if (error) throw fromPostgresError(error);

  return ok({ id: data as string, status: 'queued' }, 201);
});

export const GET = route(async (request: Request) => {
  await requireStaff();

  const url = new URL(request.url);
  const caseId = url.searchParams.get('caseId');
  const jobType = url.searchParams.get('jobType');

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('ai_jobs')
    .select('id, case_id, related_task_id, job_type, status, output, error_message, created_at, finished_at')
    .order('created_at', { ascending: false })
    .limit(LIST_PAGE_SIZE);

  // 範囲は RLS（ai_jobs_select）が担保する。ここでの絞り込みは表示上の都合。
  if (caseId) query = query.eq('case_id', caseId);
  if (jobType && (AI_JOB_TYPES as readonly string[]).includes(jobType)) {
    query = query.eq('job_type', jobType);
  }

  const { data, error } = await query;
  if (error) throw fromPostgresError(error);

  return ok({ items: data ?? [] });
});
