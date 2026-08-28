/**
 * AIジョブの入出力スキーマ（Phase 3）。
 *
 * 正本: 基本設計書 Version 1.2 7-2「AI補助機能一覧」／7-6「出力検証」。
 *
 *   「ai_jobs.input_ref／output は jsonb のため型による機械検証（12-2）が効かない。
 *     job_type ごとのJSONスキーマを zod で定義し、
 *     ワーカー・API・画面が同一定義を共有する単一ソースとする。
 *     ワーカーは出力をこのスキーマで検証してから ai_jobs.output に保存する」
 *
 * ここが単一ソースであることが、AI基盤の安全側の土台になっている。
 * LLM の出力は本質的に不定形なので、スキーマを通さずに保存すると
 * 画面が想定しない形のデータを描画することになる。
 * 検証に失敗したらリトライし、上限を超えたら failed として手動運用へフォールバックする（7-6）。
 */
import { z } from 'zod';

// ------------------------------------------------------------------ ジョブ種別
/** 7-2（コア）と 7-5（Phase 3拡張）の job_type。ai_jobs の CHECK と一致させる。 */
export const AI_JOB_TYPES = [
  'classification',
  'draft',
  'defect_check',
  'task_extraction',
  'faq_answer',
  'reschedule_plan',
  'handover_summary',
  'template_draft',
  'translation',
] as const;
export type AiJobType = (typeof AI_JOB_TYPES)[number];

/** 7-2 のコア機能。7-5 の拡張は「基盤とコア機能が動作していること」が着手条件（1-3）。 */
export const AI_CORE_JOB_TYPES: readonly AiJobType[] = [
  'classification', 'draft', 'defect_check', 'task_extraction',
];

export const AI_JOB_TYPE_LABEL: Record<AiJobType, string> = {
  classification: '自由記述の分類',
  draft: '文面の下書き',
  defect_check: '提出物の一次チェック',
  task_extraction: '宿題の起票案',
  faq_answer: 'FAQ一次回答',
  reschedule_plan: 'リスケジュール案',
  handover_summary: '引き継ぎサマリー',
  template_draft: 'テンプレート案',
  translation: '翻訳',
};

// ------------------------------------------------------------------ 9-1 分類
/**
 * 分類ラベル集合。
 * 7-2 は「ラベル集合は本書で確定し、画面（D02／K02）はこの列挙のみを扱う」と定める。
 * 増やすときは設計書の 7-2 を先に改訂する。
 */
export const CLASSIFICATION_LABELS = [
  '日程', '費用', '衣装', '料理・飲物', '装花・装飾',
  '写真・映像', '招待客・席次', '進行・演出', '支払い・手続き', 'その他',
] as const;
export type ClassificationLabel = (typeof CLASSIFICATION_LABELS)[number];

export const classificationOutputSchema = z.object({
  labels: z.array(z.enum(CLASSIFICATION_LABELS)).min(1),
  confidence: z.number().min(0).max(1),
});

// ------------------------------------------------------------- 9-2／9-3 下書き
export const draftOutputSchema = z.object({
  text: z.string().min(1),
  /** プランナーが確認すべき点。AIが断定できなかった箇所を明示させる（7-1 の確認前提） */
  cautions: z.array(z.string()).default([]),
});

// ------------------------------------------------------------- 9-4 不備チェック
export const DEFECT_TYPES = ['missing', 'duplicate', 'inconsistent_notation', 'honorific'] as const;
export type DefectType = (typeof DEFECT_TYPES)[number];

export const DEFECT_TYPE_LABEL: Record<DefectType, string> = {
  missing: '未入力',
  duplicate: '重複',
  inconsistent_notation: '表記ゆれ',
  honorific: '敬称',
};

export const defectCheckOutputSchema = z.object({
  findings: z.array(z.object({
    /** 1始まりの行番号。ヘッダー行は含めない */
    row: z.number().int().min(1),
    column: z.string(),
    type: z.enum(DEFECT_TYPES),
    detail: z.string(),
    confidence: z.number().min(0).max(1),
  })).default([]),
});

// ------------------------------------------------------------- 9-5 宿題起票案
export const taskExtractionOutputSchema = z.object({
  tasks: z.array(z.object({
    title: z.string().min(1).max(120),
    description: z.string().default(''),
    /** 「挙式2か月前ごろ」のような目安。日付に確定させないのはプランナーが決めるため */
    due_hint: z.string().default(''),
  })).default([]),
});

// ------------------------------------------------------- 9-7 FAQ（Phase 3拡張）
export const faqAnswerOutputSchema = z.object({
  /** 確信が持てない場合は回答せず null（7-5「低確信時の無回答を必須とする」） */
  answer: z.string().nullable(),
  /** 根拠の出典タイトル。7-5 は「根拠を必ず表示し」と定める */
  sources: z.array(z.object({ title: z.string(), knowledgeId: z.string().uuid().optional() }))
    .default([]),
  confidence: z.number().min(0).max(1),
});

// ------------------------------------------------------- 7-5 のその他の拡張
export const reschedulePlanOutputSchema = z.object({
  /** 日付の再配分そのものはルールベースで計算する。LLM は説明文のみ（7-5） */
  explanation: z.string(),
  cautions: z.array(z.string()).default([]),
});

export const handoverSummaryOutputSchema = z.object({
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  cautions: z.array(z.string()).default([]),
});

export const templateDraftOutputSchema = z.object({
  templates: z.array(z.object({
    name: z.string().min(1).max(120),
    description: z.string().default(''),
    due_offset_days: z.number().int().min(0),
  })).default([]),
});

export const translationOutputSchema = z.object({
  text: z.string(),
  language: z.string(),
  cautions: z.array(z.string()).default([]),
});

// ------------------------------------------------------------------ 対応表
/**
 * job_type → 出力スキーマ。
 * ワーカーはこの表を引いて検証してから保存する（7-6 出力検証）。
 */
export const AI_OUTPUT_SCHEMAS = {
  classification: classificationOutputSchema,
  draft: draftOutputSchema,
  defect_check: defectCheckOutputSchema,
  task_extraction: taskExtractionOutputSchema,
  faq_answer: faqAnswerOutputSchema,
  reschedule_plan: reschedulePlanOutputSchema,
  handover_summary: handoverSummaryOutputSchema,
  template_draft: templateDraftOutputSchema,
  translation: translationOutputSchema,
} as const satisfies Record<AiJobType, z.ZodType>;

export type AiOutput<T extends AiJobType> = z.infer<(typeof AI_OUTPUT_SCHEMAS)[T]>;

/**
 * 入力参照。
 *
 * 7-4「LLMへの入力は最小限の項目に限定する（ai_jobs.input_ref に参照とマスク済みテキストを保持）」。
 * **本文そのものを長く持たない**。参照（テーブル名とid）を持ち、
 * ワーカーが必要な分だけ読み出す。ai_jobs は保持期間が短く（13章）、
 * ここに本文を溜めると保持期間の管理対象が増える。
 */
export const aiJobInputSchema = z.object({
  /** 参照先。例: { table: 'task_submissions', id: '...' } */
  ref: z.object({
    table: z.string().min(1),
    id: z.string().uuid(),
  }).optional(),
  /** 参照だけでは足りない短いテキスト（分類対象の自由記述など）。マスク済みであること */
  text: z.string().max(4000).optional(),
  /** job_type ごとの補助パラメータ（翻訳先言語など） */
  params: z.record(z.string(), z.unknown()).default({}),
});
export type AiJobInput = z.infer<typeof aiJobInputSchema>;

/** 出力をスキーマで検証する。失敗理由をそのまま error_message に残せる形で返す。 */
export function validateAiOutput(
  jobType: AiJobType,
  output: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const parsed = AI_OUTPUT_SCHEMAS[jobType].safeParse(output);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues
      .map((i) => `${i.path.join('.') || '_'}: ${i.message}`)
      .join(' / '),
  };
}
