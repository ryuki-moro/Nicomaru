import { type SubmissionFormat, type TaskStatus } from '@/lib/constants';
import { daysBetween, type IsoDate } from '@/lib/services/schedule';

/** 一覧に表示する短い回答方法。提出画面の形式名とは用途を分ける。 */
export const TASK_ANSWER_METHOD_LABEL: Record<SubmissionFormat, string> = {
  select: '選ぶ',
  text: '入力する',
  file: 'ファイルを送る',
  none: '確認のみ',
};

/** 完了・免除後には期限までの日数を表示しない。基準日は呼び出し側がJSTで渡す。 */
export function relativeTaskDeadline(
  dueDate: IsoDate,
  today: IsoDate,
  status: TaskStatus,
): string | null {
  if (status === 'confirmed' || status === 'waived') return null;

  const days = daysBetween(dueDate, today);
  if (days > 0) return `あと${days}日`;
  if (days === 0) return '今日まで';
  return `${-days}日過ぎています`;
}
