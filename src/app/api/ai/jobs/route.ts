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
import { enqueueJob, jobList } from '@/lib/d1/ai';
import { localDB } from '@/lib/d1/runtime';
import { aiJobCreateSchemaD1 } from '@/lib/validation';
export const runtime = 'nodejs';
export const POST = route(async (request: Request) => {
  const user = await requireStaff();
  const input = await parseBody(request, aiJobCreateSchemaD1);
  return ok({ id: await enqueueJob(await localDB(), user, input), status: 'queued' }, 201);
});
export const GET = route(async (request: Request) => {
  const user = await requireStaff();
  const url = new URL(request.url);
  const caseId = url.searchParams.get('caseId');
  const jobType = url.searchParams.get('jobType');
  return ok({
    items: await jobList(await localDB(), user, caseId ?? undefined, jobType ?? undefined),
  });
});
