/**
 * リスケジュール案（9-8）のルールベース計算。
 *
 * 正本: 基本設計書 7-5「日付の再配分そのものはルールベースで計算する。LLM は説明文のみ」。
 * そのため本モジュールが日付計算の正であり、AI ジョブ（reschedule_plan）へは
 * 計算済みの結果を渡して explanation の生成だけを依頼する。
 * 説明文のフォールバックもここで決定的に作る。出力は reschedulePlanOutputSchema で検証する。
 */
import { reschedulePlanOutputSchema, type AiOutput } from '@/lib/ai/schemas';
import {
  daysBetween,
  dueDateFrom,
  formatIsoDate,
  parseIsoDate,
  type IsoDate,
} from '@/lib/services/schedule';

export type ReschedulePlanOutput = AiOutput<'reschedule_plan'>;

export interface RescheduleTaskLike {
  id: string;
  title: string;
  status: string;
  due_date: IsoDate;
  due_offset_days: number | null;
}

export interface RescheduleShift {
  id: string;
  title: string;
  from: IsoDate;
  to: IsoDate;
}

export interface ReschedulePlan {
  shifts: RescheduleShift[];
  output: ReschedulePlanOutput;
}

/**
 * 遅延宿題のリスケ案を計算する。
 *
 * 規則:
 * - 対象は未提出（not_started / needs_fix）で、期限が today より前（＝遅延）か、
 *   shiftDays 分の後ろ倒しが必要な宿題。
 * - 各宿題は「元の逆算日数（due_offset_days）を保ったまま、新しい起点日から逆算」する。
 *   起点は挙式日を shiftDays 日後ろ倒しした日ではなく、遅延を吸収するため
 *   「today から見て、元の期限と挙式日の間隔（リードタイム）を可能な限り保つ」方式にする:
 *   newDue = today + max(1, min(元のリードタイム, 挙式日まで - 1)) を基本とし、
 *   shiftDays が指定された場合は単純に due_date + shiftDays（ただし挙式日の前日までで打ち止め）。
 * - 挙式日当日・それ以降には置かない（最大で挙式前日）。
 */
export function buildReschedulePlan(input: {
  weddingDate: IsoDate;
  today: IsoDate;
  tasks: readonly RescheduleTaskLike[];
  shiftDays?: number;
}): ReschedulePlan {
  const shiftDays = input.shiftDays ?? 0;
  const wedding = parseIsoDate(input.weddingDate);
  const dayBeforeWedding = formatIsoDate(new Date(wedding.getTime() - 24 * 60 * 60 * 1000));
  const shifts: RescheduleShift[] = [];
  const cautions: string[] = [];

  for (const task of input.tasks) {
    if (task.status !== 'not_started' && task.status !== 'needs_fix') continue;
    const overdue = task.due_date < input.today;
    if (!overdue && shiftDays <= 0) continue;

    let to: IsoDate;
    if (shiftDays > 0) {
      const shifted = new Date(parseIsoDate(task.due_date).getTime() + shiftDays * 86400000);
      to = formatIsoDate(shifted);
    } else {
      // 遅延の吸収: 元のリードタイム（挙式日−期限）を保ちつつ、今日以降に置く
      const lead = Math.max(1, daysBetween(input.weddingDate, task.due_date));
      const candidate = new Date(parseIsoDate(input.today).getTime() + lead * 86400000);
      to = formatIsoDate(candidate);
      // 挙式まで lead 日の余裕が無い場合は、残り期間の半分を目安に圧縮する
      const remaining = daysBetween(input.weddingDate, input.today);
      if (to >= input.weddingDate && remaining > 1) {
        const compressed = new Date(
          parseIsoDate(input.today).getTime() + Math.floor(remaining / 2) * 86400000,
        );
        to = formatIsoDate(compressed);
        cautions.push(`「${task.title}」は挙式までの期間が短いため、期限を圧縮して提案しています`);
      }
    }
    if (to > dayBeforeWedding) to = dayBeforeWedding;
    if (to <= input.today && dayBeforeWedding > input.today) {
      cautions.push(
        `「${task.title}」の新しい期限に余裕がありません。プランナーが個別に判断してください`,
      );
    }
    if (to !== task.due_date)
      shifts.push({ id: task.id, title: task.title, from: task.due_date, to });
  }

  const explanation =
    shifts.length === 0
      ? '遅れている宿題はありません。現在の期限のままで問題ありません。'
      : `次の${shifts.length}件の宿題について、期限の見直し案を作成しました。` +
        shifts.map((s) => `「${s.title}」は ${s.from} から ${s.to} へ変更する案です。`).join('') +
        '日付の計算はルールに基づいており、最終的な決定はプランナーが行います。';

  const output = reschedulePlanOutputSchema.parse({ explanation, cautions });
  // dueDateFrom を使う経路（逆算日数ベース）も検証しておく: offset が負になる案はここで弾かれる
  for (const s of shifts) {
    const offset = daysBetween(input.weddingDate, s.to);
    if (offset < 0) throw new Error(`リスケ案の日付が挙式日を超えています: ${s.title}`);
    void dueDateFrom(input.weddingDate, offset);
  }
  return { shifts, output };
}

/** ジョブ投入用の入力テキスト（計算済みの結果だけを渡し、日付を LLM に再計算させない）。 */
export function rescheduleJobInput(plan: ReschedulePlan): {
  text: string;
  params: Record<string, unknown>;
} {
  return {
    text:
      plan.shifts.map((s) => `「${s.title}」: ${s.from} → ${s.to}`).join('\n') ||
      '変更対象の宿題はありません',
    params: { shifts: plan.shifts },
  };
}
