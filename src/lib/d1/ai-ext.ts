/**
 * AI拡張（Issue #118、9-8〜9-11）の D1 側ヘルパー。
 *
 * 投入は既存の enqueueJob（src/lib/d1/ai.ts）を再利用し、式場境界・暗号化・心拍の扱いを揃える。
 * ここが担うのは「サーバー側で事実を集約してから投入すること」と「案件単位の最新ジョブ取得」。
 * 日付計算・集約・辞書といった決定的な部分は src/lib/ai/ 配下の純関数に置き、
 * ワーカーが居ない環境でもフォールバックとしてそのまま画面に出せるようにする。
 */
import type { D1Database } from '@cloudflare/workers-types';

import {
  aggregateHandover,
  buildHandoverFallback,
  handoverJobInput,
  type HandoverSummaryOutput,
} from '@/lib/ai/handover';
import { buildReschedulePlan, rescheduleJobInput, type ReschedulePlan } from '@/lib/ai/reschedule';
import type { AiJobType } from '@/lib/ai/schemas';
import {
  buildTemplateDraft,
  templateDraftJobInput,
  type ExistingTemplateLike,
} from '@/lib/ai/template-draft';
import { todayInJst } from '@/lib/format';
import { daysBetween, type IsoDate } from '@/lib/services/schedule';

import { enqueueJob, jobList } from './ai';
import { caseRow } from './cases';

type Actor = { id: string; role?: string };

export type ExtJobType = Extract<
  AiJobType,
  'translation' | 'template_draft' | 'handover_summary' | 'reschedule_plan'
>;

/** 案件単位（宿題に紐づかない）ジョブの最新1件。discarded は jobList 側の並びに含まれるため呼び出し側で扱う。 */
export async function latestExtJob(
  db: D1Database,
  user: Actor,
  caseId: string,
  jobType: ExtJobType,
) {
  const items = await jobList(db, user as never, caseId, jobType);
  return items.find((j) => j.status !== 'discarded') ?? null;
}

function todayJst(): IsoDate {
  // サーバー側の「今日」は JST 基準（既存の集計と同じ考え方）。
  return todayInJst();
}

/** ③ 引継ぎ: 案件の宿題状態を集約し、フォールバックとジョブ投入をまとめて返す。 */
export async function prepareHandover(db: D1Database, user: Actor, caseId: string) {
  const row = await caseRow(db, user as never, caseId);
  const today = todayJst();
  const aggregate = aggregateHandover(row.case_tasks, today);
  const fallback: HandoverSummaryOutput = buildHandoverFallback({
    caseCode: row.case_code,
    weddingDate: row.wedding_date,
    today,
    aggregate,
  });
  return { aggregate, fallback, weddingDate: row.wedding_date, caseCode: row.case_code };
}

export async function enqueueHandover(db: D1Database, user: Actor, caseId: string) {
  const prepared = await prepareHandover(db, user, caseId);
  const input = handoverJobInput({
    caseCode: prepared.caseCode,
    weddingDate: prepared.weddingDate,
    aggregate: prepared.aggregate,
  });
  const id = await enqueueJob(db, user as never, {
    caseId,
    jobType: 'handover_summary',
    input,
  });
  return { id, fallback: prepared.fallback };
}

/** ④ リスケ: 日付はルールで先に計算し、ジョブへは説明文の生成だけを依頼する（7-5）。 */
export async function prepareReschedule(
  db: D1Database,
  user: Actor,
  caseId: string,
  shiftDays = 0,
): Promise<ReschedulePlan & { weddingDate: IsoDate }> {
  const row = await caseRow(db, user as never, caseId);
  const plan = buildReschedulePlan({
    weddingDate: row.wedding_date,
    today: todayJst(),
    tasks: row.case_tasks,
    shiftDays,
  });
  return { ...plan, weddingDate: row.wedding_date };
}

export async function enqueueReschedule(
  db: D1Database,
  user: Actor,
  caseId: string,
  shiftDays = 0,
) {
  const plan = await prepareReschedule(db, user, caseId, shiftDays);
  const id = await enqueueJob(db, user as never, {
    caseId,
    jobType: 'reschedule_plan',
    input: rescheduleJobInput(plan),
  });
  return { id, plan };
}

/** ② テンプレート案: プランの templates_json（実データ）と既存の案件宿題から案を作る。 */
export async function prepareTemplateDraft(db: D1Database, user: Actor, caseId: string) {
  const row = await caseRow(db, user as never, caseId);
  let planTemplates: ExistingTemplateLike[] = [];
  if (row.plan_type_id) {
    const plan = await db
      .prepare('SELECT templates_json FROM plan_types WHERE id=? AND venue_id=?')
      .bind(row.plan_type_id, row.venue_id)
      .first<{ templates_json: string }>();
    if (plan) {
      try {
        const parsed = JSON.parse(plan.templates_json) as {
          title?: string;
          dueOffsetDays?: number;
        }[];
        planTemplates = parsed
          .filter((t) => typeof t.title === 'string')
          .map((t) => ({ name: t.title as string, due_offset_days: t.dueOffsetDays ?? 30 }));
      } catch {
        planTemplates = [];
      }
    }
  }
  const existing: ExistingTemplateLike[] = [
    ...planTemplates,
    ...row.case_tasks.map((t) => ({
      name: t.title,
      due_offset_days: t.due_offset_days ?? 0,
    })),
  ];
  const daysUntil = daysBetween(row.wedding_date, todayJst());
  const draft = buildTemplateDraft({
    existing,
    daysUntilWedding: daysUntil,
    planName: row.plan_types?.name ?? null,
  });
  return { draft, existing, daysUntilWedding: daysUntil, planName: row.plan_types?.name ?? null };
}

export async function enqueueTemplateDraft(db: D1Database, user: Actor, caseId: string) {
  const prepared = await prepareTemplateDraft(db, user, caseId);
  const id = await enqueueJob(db, user as never, {
    caseId,
    jobType: 'template_draft',
    input: templateDraftJobInput(prepared),
  });
  return { id, draft: prepared.draft };
}

/** ① 翻訳: 投入だけを行う（結果表示・採用は D02 のパネル側）。 */
export async function enqueueTranslation(
  db: D1Database,
  user: Actor,
  input: { caseId: string; relatedTaskId?: string | null; text: string; language: string },
) {
  return enqueueJob(db, user as never, {
    caseId: input.caseId,
    jobType: 'translation',
    relatedTaskId: input.relatedTaskId ?? null,
    input: {
      text: input.text.slice(0, 4000),
      params: { language: input.language },
    },
  });
}
