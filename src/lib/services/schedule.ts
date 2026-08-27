/**
 * 挙式日からの逆算と、案件更新に伴う期限の再計算。
 *
 * 正本: 基本設計書 Version 1.2 6-6-2「宿題一括割当とトランザクション境界」。
 * 第11章のユニットテスト対象（分岐網羅100%）であり、DBに依存しない純関数として実装する。
 */
import {
  INCOMPLETE_TASK_STATUSES,
  UNSUBMITTED_TASK_STATUSES,
  type Importance,
  type SubmissionFormat,
  type TaskStatus,
} from '@/lib/constants';

/** 日付のみを扱う。タイムゾーンの影響を受けないよう 'YYYY-MM-DD' 文字列で持つ。 */
export type IsoDate = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(value: IsoDate): Date {
  if (!DATE_RE.test(value)) {
    throw new Error(`日付の形式が不正です: ${value}`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`日付として解釈できません: ${value}`);
  }
  return date;
}

export function formatIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/** 挙式日から offset 日前の期限を求める（6-6-2）。 */
export function dueDateFrom(weddingDate: IsoDate, offsetDays: number): IsoDate {
  if (!Number.isInteger(offsetDays) || offsetDays < 0) {
    throw new Error(`逆算日数は0以上の整数である必要があります: ${offsetDays}`);
  }
  const base = parseIsoDate(weddingDate);
  base.setUTCDate(base.getUTCDate() - offsetDays);
  return formatIsoDate(base);
}

/** 日数差（a - b）。負値は a が b より前。 */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((parseIsoDate(a).getTime() - parseIsoDate(b).getTime()) / MS_PER_DAY);
}

// -------------------------------------------------------------------- 一括割当
export interface TemplateForAssign {
  taskTemplateId: string;
  title: string;
  description: string | null;
  submissionFormat: SubmissionFormat;
  allowedFileTypes: string[];
  options: Record<string, unknown>;
  importance: Importance;
  /** テンプレート側の逆算日数 */
  dueOffsetDays: number;
  /** プラン固有の上書き。null ならテンプレート値を使う */
  dueOffsetDaysOverride: number | null;
  /** プラン内で必須か（plan_task_templates 側の値を優先する） */
  isRequired: boolean;
  displayOrder: number;
}

export interface PlannedTask {
  taskTemplateId: string;
  title: string;
  description: string | null;
  submissionFormat: SubmissionFormat;
  allowedFileTypes: string[];
  options: Record<string, unknown>;
  isRequired: boolean;
  importance: Importance;
  dueDate: IsoDate;
  displayOrder: number;
}

/**
 * プラン種別のテンプレートから case_tasks の内容を組み立てる。
 *
 * - submission_format／allowed_file_types／options／is_required／importance／display_order を
 *   スナップショットする（テンプレートを後から変更しても既存案件の宿題は変わらない）。
 * - 再実行時は未割当のテンプレート分のみを返し、既存 case_tasks は変更しない（エラーにしない）。
 */
export function planTasks(
  weddingDate: IsoDate,
  templates: readonly TemplateForAssign[],
  alreadyAssignedTemplateIds: readonly string[] = [],
): PlannedTask[] {
  const assigned = new Set(alreadyAssignedTemplateIds);
  return templates
    .filter((t) => !assigned.has(t.taskTemplateId))
    .map((t) => ({
      taskTemplateId: t.taskTemplateId,
      title: t.title,
      description: t.description,
      submissionFormat: t.submissionFormat,
      allowedFileTypes: t.allowedFileTypes,
      options: t.options,
      isRequired: t.isRequired,
      importance: t.importance,
      dueDate: dueDateFrom(weddingDate, t.dueOffsetDaysOverride ?? t.dueOffsetDays),
      displayOrder: t.displayOrder,
    }));
}

/** タイムライン項目の見出しに使う区分（表5-14 phase_name）。 */
export function phaseNameFor(weddingDate: IsoDate, dueDate: IsoDate): string {
  const days = daysBetween(weddingDate, dueDate);
  if (days >= 180) return '6か月前';
  if (days >= 90) return '3か月前';
  if (days >= 60) return '2か月前';
  if (days >= 30) return '1か月前';
  if (days >= 14) return '2週間前';
  if (days >= 7) return '1週間前';
  return '直前';
}

// ------------------------------------------------------------------ 期限再計算
export interface ExistingTask {
  id: string;
  taskTemplateId: string | null;
  title: string;
  status: TaskStatus;
  dueDate: IsoDate;
  /** 割当元テンプレートの逆算日数。個別追加（task_template_id が NULL）は null */
  dueOffsetDays: number | null;
}

export interface DueDateChange {
  id: string;
  title: string;
  from: IsoDate;
  to: IsoDate;
}

/**
 * 挙式日を変更したときの期限再計算（6-6-2、K04 の差分確認ダイアログの元データ）。
 *
 * - 未提出（not_started／needs_fix）のみ再計算する。
 * - submitted／confirmed／waived は据え置く。
 * - 個別追加の宿題（逆算日数を持たない）は再計算対象外とする。
 */
export function recalculateDueDates(
  newWeddingDate: IsoDate,
  tasks: readonly ExistingTask[],
): DueDateChange[] {
  return tasks
    .filter((t) => UNSUBMITTED_TASK_STATUSES.includes(t.status))
    .filter((t) => t.dueOffsetDays !== null)
    .map((t) => ({
      id: t.id,
      title: t.title,
      from: t.dueDate,
      to: dueDateFrom(newWeddingDate, t.dueOffsetDays as number),
    }))
    .filter((c) => c.from !== c.to);
}

export interface PlanChangePreview {
  /** 旧プラン由来かつ not_started のため waived にする宿題 */
  waived: { id: string; title: string }[];
  /** 新プランで追加されるテンプレート */
  added: { taskTemplateId: string; title: string; dueDate: IsoDate }[];
  /** 提出済みなどで据え置く宿題 */
  kept: { id: string; title: string; status: TaskStatus }[];
}

/**
 * プラン種別を変更したときの差分（6-6-2、K04 の差分確認ダイアログ）。
 *
 * - 旧プラン由来かつ not_started の宿題を waived にする（削除はしない）。
 * - 新プラン分のテンプレートを追加する。
 * - 提出済みの宿題はそのまま残す。
 */
export function previewPlanChange(
  weddingDate: IsoDate,
  existing: readonly ExistingTask[],
  newTemplates: readonly TemplateForAssign[],
): PlanChangePreview {
  const newTemplateIds = new Set(newTemplates.map((t) => t.taskTemplateId));
  const existingTemplateIds = new Set(
    existing.map((t) => t.taskTemplateId).filter((id): id is string => id !== null),
  );

  const waived: PlanChangePreview['waived'] = [];
  const kept: PlanChangePreview['kept'] = [];

  for (const task of existing) {
    const fromOldPlan = task.taskTemplateId !== null && !newTemplateIds.has(task.taskTemplateId);
    if (fromOldPlan && task.status === 'not_started') {
      waived.push({ id: task.id, title: task.title });
    } else {
      kept.push({ id: task.id, title: task.title, status: task.status });
    }
  }

  const added = newTemplates
    .filter((t) => !existingTemplateIds.has(t.taskTemplateId))
    .map((t) => ({
      taskTemplateId: t.taskTemplateId,
      title: t.title,
      dueDate: dueDateFrom(weddingDate, t.dueOffsetDaysOverride ?? t.dueOffsetDays),
    }));

  return { waived, added, kept };
}

// --------------------------------------------------------------- 表示用の集計
/** M01「次にやること」（最大3件。ORDER BY due_date, display_order, id）。 */
export function nextActions<T extends { status: TaskStatus; dueDate: IsoDate; displayOrder: number; id: string }>(
  tasks: readonly T[],
  limit = 3,
): T[] {
  return [...tasks]
    .filter((t) => INCOMPLETE_TASK_STATUSES.includes(t.status))
    .sort((a, b) =>
      a.dueDate.localeCompare(b.dueDate)
      || a.displayOrder - b.displayOrder
      || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** 挙式日までの残日数。当日は 0、過ぎていれば負値。 */
export function daysUntilWedding(weddingDate: IsoDate, today: IsoDate): number {
  return daysBetween(weddingDate, today);
}
