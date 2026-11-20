import { describe, expect, it } from 'vitest';

import { SUBMISSION_FORMATS, TASK_STATUSES } from '@/lib/constants';
import { todayInJst } from '@/lib/format';
import {
  MISSING_ANSWER_REASON,
  relativeTaskDeadline,
  TASK_ANSWER_METHOD_LABEL,
} from '@/lib/task-display';

describe('回答が空のときの理由', () => {
  it('ファイルの宿題は、選ぶ操作が分かる文言にする', () => {
    expect(MISSING_ANSWER_REASON.file).toBe('ファイルを選んでください');
  });

  it('テキスト・選択式の文言は変えない', () => {
    expect(MISSING_ANSWER_REASON.text).toBe('回答を入力してください');
    expect(MISSING_ANSWER_REASON.select).toBe('回答を入力してください');
  });
});

describe('宿題の相対期限', () => {
  it.each([
    ['2026-10-23', 'あと1日'],
    ['2026-10-22', '今日まで'],
    ['2026-10-21', '1日過ぎています'],
  ])('%sを正しい日数で表示する', (dueDate, expected) => {
    expect(relativeTaskDeadline(dueDate, '2026-10-22', 'not_started')).toBe(expected);
  });

  it('月末・年末・うるう日をまたいでも暦日で数える', () => {
    expect(relativeTaskDeadline('2028-02-29', '2028-02-28', 'needs_fix')).toBe('あと1日');
    expect(relativeTaskDeadline('2028-03-01', '2028-02-28', 'submitted')).toBe('あと2日');
    expect(relativeTaskDeadline('2027-01-01', '2026-12-31', 'not_started')).toBe('あと1日');
  });

  it('JSTの今日を基準に切り替わる', () => {
    const beforeMidnight = todayInJst(new Date('2026-10-21T14:59:59Z'));
    const afterMidnight = todayInJst(new Date('2026-10-21T15:00:00Z'));
    expect(relativeTaskDeadline('2026-10-22', beforeMidnight, 'not_started')).toBe('あと1日');
    expect(relativeTaskDeadline('2026-10-22', afterMidnight, 'not_started')).toBe('今日まで');
  });

  it.each(TASK_STATUSES)('%sでは完了・免除だけ期限を隠す', (status) => {
    expect(relativeTaskDeadline('2026-10-20', '2026-10-22', status)).toBe(
      status === 'confirmed' || status === 'waived' ? null : '2日過ぎています',
    );
  });
});

describe('回答方法の短いラベル', () => {
  it('全提出形式に対応する', () => {
    expect(SUBMISSION_FORMATS.map((format) => TASK_ANSWER_METHOD_LABEL[format])).toEqual([
      '入力する',
      '選ぶ',
      'ファイルを送る',
      '確認のみ',
    ]);
  });
});
