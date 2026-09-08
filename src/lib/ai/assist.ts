/**
 * AI補助をサーバー側から使うための共通処理（Phase 3、機能9-1〜9-5）。
 *
 * 正本: 基本設計書 7-1／7-2／7-3。
 *
 * 画面（Server Component）とAPIの双方から使うため、'use client' を付けない。
 * ここに集めているのは次の3種類。
 *
 *   - 「利用不可」判定（7-1／7-3 (4)）
 *   - 採用された出力の取り出し（7-2 の 9-1「プランナーが修正できる」）
 *   - 提出を契機とするジョブ投入（7-3）
 *
 * どの関数も **失敗しても業務処理を止めない**。
 * 7-1 が「LLMサーバー停止時は…他機能の利用に影響を与えない」と定めているため、
 * AI 側の不調が提出や確認の失敗になってはいけない。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  AI_OUTPUT_SCHEMAS,
  type AiJobType,
  type AiOutput,
} from '@/lib/ai/schemas';

/** ai_jobs の状態（5-3 の CHECK と一致）。 */
export type AiJobStatus = 'queued' | 'processing' | 'done' | 'failed' | 'confirmed' | 'discarded';

/** 画面が扱うジョブ1件。本文（input_ref）は含めない（7-4）。 */
export interface AiJobRow {
  id: string;
  case_id: string | null;
  related_task_id: string | null;
  job_type: AiJobType;
  status: AiJobStatus;
  output: unknown;
  reviewed_output: unknown;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

/** 画面・APIが select する列。reviewed_output を落とすと採用済みの修正が見えなくなる。 */
export const AI_JOB_COLUMNS =
  'id, case_id, related_task_id, job_type, status, output, reviewed_output,'
  + ' error_message, created_at, finished_at';

/** 生成待ち・生成中。画面は「依頼中」と出す。 */
export const AI_JOB_PENDING: readonly AiJobStatus[] = ['queued', 'processing'];

export interface AiAssistStatus {
  /** 7-3 (4)「最終ポーリングから10分以上経過」していなければ true */
  available: boolean;
  lastSeenAt: string | null;
}

/**
 * ワーカーの死活（7-1「LLMサーバー停止時は該当機能を『利用不可』と表示し、
 * 手動運用にフォールバックする」）。
 *
 * 取得に失敗したときは「利用不可」を返す。
 * 判定できないことを「使える」と見せると、押しても返ってこないボタンを出すことになる。
 */
export async function fetchAiAssistStatus(supabase: SupabaseClient): Promise<AiAssistStatus> {
  const { data, error } = await supabase.rpc('ai_assist_status').maybeSingle();
  if (error || !data) {
    if (error) console.warn('[ai] ワーカーの死活を取得できませんでした', error);
    return { available: false, lastSeenAt: null };
  }
  const row = data as { available: boolean; last_seen_at: string | null };
  return { available: row.available === true, lastSeenAt: row.last_seen_at };
}

/**
 * 採用済みの出力を取り出す。
 *
 * プランナーが修正して採用した場合は reviewed_output が入っている（7-2 の 9-1）。
 * AI の生出力（output）は残したまま、表示だけを差し替えるのが狙い。
 *
 * 保存時にスキーマ検証を通しているが、画面側でも通す。
 * 保存後にスキーマを変えた場合、古い行が新しい画面の想定と食い違うため。
 */
export function adoptedOutput<T extends AiJobType>(
  jobType: T,
  job: Pick<AiJobRow, 'output' | 'reviewed_output'> | null | undefined,
): AiOutput<T> | null {
  if (!job) return null;
  const raw = job.reviewed_output ?? job.output;
  if (raw == null) return null;
  const parsed = AI_OUTPUT_SCHEMAS[jobType].safeParse(raw);
  return parsed.success ? (parsed.data as AiOutput<T>) : null;
}

/**
 * 宿題に紐づく最新のジョブを1件取る（D02 の分類・不備チェック表示）。
 *
 * 参照範囲は RLS（ai_jobs_select）が担保する。ここでの絞り込みは表示上の都合。
 * discarded は「見なかったことにした」結果なので拾わない。
 */
export async function latestJobForTask(
  supabase: SupabaseClient,
  taskId: string,
  jobType: AiJobType,
): Promise<AiJobRow | null> {
  const { data, error } = await supabase
    .from('ai_jobs')
    .select(AI_JOB_COLUMNS)
    .eq('related_task_id', taskId)
    .eq('job_type', jobType)
    .neq('status', 'discarded')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[ai] ジョブを取得できませんでした', jobType, error);
    return null;
  }
  return (data as AiJobRow | null) ?? null;
}

/**
 * 提出を契機とするジョブの投入（7-3）。
 *
 *   「提出・打ち合わせ記録登録を契機とするジョブは couple／planner の操作APIの
 *     サーバー側処理から内部呼び出しで投入し、クライアントから /api/ai/jobs を直接呼ばせない」
 *
 * couple は enqueue_ai_job() を呼べないため（job_type と case_id を自由に選べてしまう）、
 * 宿題から案件を引く enqueue_submission_ai_job() を使う。
 *
 * 投入に失敗しても例外は投げない（提出処理から呼ぶため）。
 * AI は補助であって提出の要件ではない（7-1）。
 * 失敗を呼び出し側で扱いたい場合のために、投入できたジョブIDを返す。
 */
export async function enqueueSubmissionAiJob(
  supabase: SupabaseClient,
  taskId: string,
  jobType: Extract<AiJobType, 'classification' | 'defect_check'>,
  input: { ref?: { table: string; id: string }; text?: string; params?: Record<string, unknown> },
): Promise<string | null> {
  const { data, error } = await supabase.rpc('enqueue_submission_ai_job', {
    p_case_task_id: taskId,
    p_job_type: jobType,
    p_input_ref: { params: {}, ...input },
  });
  if (error) {
    console.warn('[ai] ジョブを投入できませんでした', jobType, error);
    return null;
  }
  return (data as string | null) ?? null;
}

/**
 * 分類（9-1）へ渡すテキストの整形。
 *
 * 7-4「LLMへの入力は処理に必要な最小限の項目に限定する」。
 * 自由記述そのものが分類対象なので渡さざるを得ないが、長さは切る。
 * ai_jobs の保持期間は短く定める（13章）ため、ここに長文を溜めない。
 */
export const AI_INPUT_TEXT_MAX = 2000;

export function trimForAi(text: string | null | undefined): string | null {
  const value = (text ?? '').trim();
  if (value === '') return null;
  return value.length > AI_INPUT_TEXT_MAX ? value.slice(0, AI_INPUT_TEXT_MAX) : value;
}
