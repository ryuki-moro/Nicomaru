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

import { AI_OUTPUT_SCHEMAS, type AiJobType, type AiOutput } from '@/lib/ai/schemas';

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
  'id, case_id, related_task_id, job_type, status, output, reviewed_output,' +
  ' error_message, created_at, finished_at';

/** 生成待ち・生成中。画面は「依頼中」と出す。 */
export const AI_JOB_PENDING: readonly AiJobStatus[] = ['queued', 'processing'];

export interface AiAssistStatus {
  /** 7-3 (4)「最終ポーリングから10分以上経過」していなければ true */
  available: boolean;
  lastSeenAt: string | null;
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
