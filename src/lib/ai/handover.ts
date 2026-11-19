/**
 * 担当引継ぎサマリー（9-9）の集約とフォールバック生成。
 *
 * 正本: 基本設計書 7-5「引き継ぎサマリー」。サーバー側で案件の宿題状態・提出・期限を
 * 構造化してからジョブ投入するのが前提（LLM に生データを探させない）。
 * ワーカーが居ない環境では、この集約結果から決定的にサマリー文を組み立てる。
 * 出力は handoverSummaryOutputSchema で検証する。
 */
import { handoverSummaryOutputSchema, type AiOutput } from '@/lib/ai/schemas';
import { daysBetween, type IsoDate } from '@/lib/services/schedule';

export type HandoverSummaryOutput = AiOutput<'handover_summary'>;

export interface HandoverTaskLike {
  title: string;
  status: string;
  due_date: IsoDate;
}

export interface HandoverAggregate {
  total: number;
  confirmed: number;
  submitted: number;
  needsFix: number;
  notStarted: number;
  waived: number;
  overdueTitles: string[];
  needsFixTitles: string[];
  nearestDue: IsoDate | null;
}

/** 宿題一覧を集約する。today は 'YYYY-MM-DD'。 */
export function aggregateHandover(
  tasks: readonly HandoverTaskLike[],
  today: IsoDate,
): HandoverAggregate {
  const overdue = tasks.filter(
    (t) => (t.status === 'not_started' || t.status === 'needs_fix') && t.due_date < today,
  );
  const open = tasks
    .filter(
      (t) => t.status === 'not_started' || t.status === 'needs_fix' || t.status === 'submitted',
    )
    .map((t) => t.due_date)
    .sort();
  return {
    total: tasks.length,
    confirmed: tasks.filter((t) => t.status === 'confirmed').length,
    submitted: tasks.filter((t) => t.status === 'submitted').length,
    needsFix: tasks.filter((t) => t.status === 'needs_fix').length,
    notStarted: tasks.filter((t) => t.status === 'not_started').length,
    waived: tasks.filter((t) => t.status === 'waived').length,
    overdueTitles: overdue.map((t) => t.title),
    needsFixTitles: tasks.filter((t) => t.status === 'needs_fix').map((t) => t.title),
    nearestDue: open[0] ?? null,
  };
}

/** 集約結果からフォールバックのサマリーを作る（LLM 不要・決定的）。 */
export function buildHandoverFallback(input: {
  caseCode: string;
  weddingDate: IsoDate;
  today: IsoDate;
  aggregate: HandoverAggregate;
}): HandoverSummaryOutput {
  const a = input.aggregate;
  const days = daysBetween(input.weddingDate, input.today);
  const summary =
    `案件 ${input.caseCode}（挙式日 ${input.weddingDate}、あと${days}日）。` +
    `宿題は全${a.total}件中、確認済み${a.confirmed}件、提出済み（確認待ち）${a.submitted}件、` +
    `差し戻し中${a.needsFix}件、未着手${a.notStarted}件、対応不要${a.waived}件です。` +
    (a.nearestDue ? `直近の期限は ${a.nearestDue} です。` : '未完了の宿題はありません。');
  const decisions: string[] = [];
  if (a.confirmed > 0)
    decisions.push(`確認済みの宿題が${a.confirmed}件あります（再確認は不要です）`);
  if (a.submitted > 0)
    decisions.push(`提出済みでプランナー確認待ちの宿題が${a.submitted}件あります`);
  const cautions: string[] = [];
  for (const title of a.overdueTitles) cautions.push(`期限を過ぎた宿題があります: ${title}`);
  for (const title of a.needsFixTitles) cautions.push(`差し戻し中の宿題があります: ${title}`);
  if (a.submitted > 0)
    cautions.push('確認待ちの提出が滞留しないよう、引き継ぎ後すぐに確認してください');
  return handoverSummaryOutputSchema.parse({ summary, decisions, cautions });
}

/** ジョブ投入用の入力テキスト（集約済みの事実だけを渡す。氏名等の個人情報は含めない）。 */
export function handoverJobInput(input: {
  caseCode: string;
  weddingDate: IsoDate;
  aggregate: HandoverAggregate;
}): { text: string; params: Record<string, unknown> } {
  const a = input.aggregate;
  return {
    text: [
      `案件番号: ${input.caseCode}`,
      `挙式日: ${input.weddingDate}`,
      `宿題: 全${a.total}件 / 確認済み${a.confirmed} / 提出済み${a.submitted} / 差し戻し${a.needsFix} / 未着手${a.notStarted} / 対応不要${a.waived}`,
      a.overdueTitles.length ? `期限超過: ${a.overdueTitles.join('、')}` : '',
      a.needsFixTitles.length ? `差し戻し中: ${a.needsFixTitles.join('、')}` : '',
      a.nearestDue ? `直近の期限: ${a.nearestDue}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    params: { source: 'handover_aggregate' },
  };
}
