/**
 * 宿題テンプレート案（9-10）のルール生成。
 *
 * 正本: 基本設計書 7-5「テンプレート案」。AI ジョブ（template_draft）の結果が無い環境でも、
 * 既存テンプレートの実データと標準的な準備の流れから案を組み立てられるようにする縮退実装。
 * 生成した案は templateDraftOutputSchema で検証する。登録は既存のテンプレート作成導線を通す（ここでは登録しない）。
 */
import { templateDraftOutputSchema, type AiOutput } from '@/lib/ai/schemas';

export type TemplateDraftOutput = AiOutput<'template_draft'>;

export interface ExistingTemplateLike {
  name: string;
  due_offset_days: number;
}

/**
 * 標準的な準備項目。既存テンプレートに同名があれば出さない。
 * due_offset_days は挙式日から逆算した一般的な目安（schedule.ts の逆算と同じ考え方）。
 */
const STANDARD_ITEMS: readonly { name: string; description: string; due_offset_days: number }[] = [
  {
    name: '招待客リストの作成',
    description: '招待する方の氏名・人数をリストにまとめて提出してください',
    due_offset_days: 90,
  },
  {
    name: '衣装の試着と決定',
    description: '試着の結果と決定した衣装をお知らせください',
    due_offset_days: 60,
  },
  {
    name: '料理・引出物の候補選び',
    description: '試食の感想と候補を提出してください',
    due_offset_days: 45,
  },
  {
    name: '席次の作成',
    description: '卓ごとの配置案を作成して提出してください',
    due_offset_days: 30,
  },
  {
    name: 'BGM・演出の希望まとめ',
    description: '使いたい曲と演出の希望をまとめて提出してください',
    due_offset_days: 21,
  },
  {
    name: '誓いの言葉・手紙の準備',
    description: '当日に読む文面の下書きを提出してください',
    due_offset_days: 14,
  },
  {
    name: '最終確認（持ち物・集合時間）',
    description: '当日の持ち物と集合時間を確認して回答してください',
    due_offset_days: 7,
  },
];

/**
 * 案を組み立てる。
 * - 既存テンプレートと名前が重なる項目は出さない
 * - 挙式までの残期間（daysUntilWedding）が分かる場合は、それを超える逆算日数の項目は出さない
 *   （既に過ぎた準備段階の宿題を今さら案に出しても使えないため）
 */
export function buildTemplateDraft(input: {
  existing: readonly ExistingTemplateLike[];
  daysUntilWedding?: number | null;
  planName?: string | null;
}): TemplateDraftOutput {
  const existingNames = new Set(input.existing.map((t) => t.name.trim()));
  const limit = input.daysUntilWedding ?? null;
  const fromStandard = STANDARD_ITEMS.filter(
    (item) => !existingNames.has(item.name) && (limit === null || item.due_offset_days <= limit),
  ).map((item) => ({ ...item }));

  // 既存テンプレートが1件も無い式場では、既存の逆算日数の分布も手がかりにならないため標準セットのみ。
  // 既存がある場合は、標準セットに無い観点として「既存の最大逆算より前倒し」の案は出さない（上の limit で担保）。
  return templateDraftOutputSchema.parse({ templates: fromStandard });
}

/** ジョブ投入用の入力テキスト（7-4 の入力最小化: テンプレート名と逆算日数だけを渡す）。 */
export function templateDraftJobInput(input: {
  existing: readonly ExistingTemplateLike[];
  daysUntilWedding?: number | null;
  planName?: string | null;
}): { text: string; params: Record<string, unknown> } {
  const lines = input.existing.map((t) => `${t.name}（挙式${t.due_offset_days}日前）`);
  return {
    text: [
      `プラン種別: ${input.planName ?? '未設定'}`,
      input.daysUntilWedding != null ? `挙式まで: ${input.daysUntilWedding}日` : '',
      `既存テンプレート:\n${lines.join('\n') || '（なし）'}`,
    ]
      .filter(Boolean)
      .join('\n'),
    params: { source: 'template_draft_rule' },
  };
}
