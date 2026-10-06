import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/errors';
import {
  notificationLogBounds,
  notificationLogExportSchema,
  parseNotificationLogPeriod,
} from '@/lib/notification-log-export';

describe('通知ログCSVの期間', () => {
  it.each(['', 'from=&to='])('省略・空欄は期間制限なし (%s)', (query) => {
    expect(parseNotificationLogPeriod(new URLSearchParams(query))).toEqual({
      from: undefined, to: undefined,
    });
    expect(notificationLogBounds({})).toEqual({ from: undefined, toExclusive: undefined });
  });

  it.each(['2026-01-31', '2024-02-29', '2000-02-29', '0001-01-01', '9999-12-31'])(
    '実在する日付 %s を受け入れる', (day) => {
      expect(notificationLogExportSchema.safeParse({ from: day, to: day }).success).toBe(true);
    },
  );

  it.each([
    '2026-02-30', '2026-04-31', '2023-02-29', '1900-02-29', '2100-02-29',
    '2026-13-01', '2026-00-01', '2026-01-00', '0000-01-01', '10000-01-01',
    '2026-1-1', '2026/01/01', '2026-01-01T00:00:00Z', ' 2026-01-01 ', 'invalid',
  ])('不正な日付 %s は項目を示す400', (day) => {
    const params = new URLSearchParams({ from: day });
    try {
      parseNotificationLogPeriod(params);
      throw new Error('不正な日付を受け入れました');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
      expect((error as ApiError).details).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'from' }),
      ]));
    }
  });

  it('逆順の期間は終了日の項目エラー', () => {
    expect(() => parseNotificationLogPeriod(new URLSearchParams({
      from: '2026-10-07', to: '2026-10-06',
    }))).toThrow(expect.objectContaining({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'to', reason: '終了日は開始日以降の日付を指定してください' }],
    }));
  });

  it.each(['from', 'to'])('同じ%sの重複指定は400', (field) => {
    const params = new URLSearchParams([[field, '2026-10-06'], [field, '2026-10-06']]);
    expect(() => parseNotificationLogPeriod(params)).toThrow(expect.objectContaining({
      code: 'VALIDATION_ERROR', status: 400,
      details: [{ field, reason: '同じ項目を複数指定しないでください' }],
    }));
  });

  it('両項目が重複した場合は両方を報告する', () => {
    expect(() => parseNotificationLogPeriod(new URLSearchParams(
      'from=&from=&to=&to=',
    ))).toThrow(expect.objectContaining({
      details: [
        { field: 'from', reason: '同じ項目を複数指定しないでください' },
        { field: 'to', reason: '同じ項目を複数指定しないでください' },
      ],
    }));
  });

  it('開始日だけ・終了日だけも指定できる', () => {
    expect(notificationLogBounds(parseNotificationLogPeriod(new URLSearchParams(
      'from=2026-10-06',
    )))).toEqual({ from: '2026-10-06T00:00:00+09:00', toExclusive: undefined });
    expect(notificationLogBounds(parseNotificationLogPeriod(new URLSearchParams(
      'to=2026-10-06',
    )))).toEqual({ from: undefined, toExclusive: '2026-10-07T00:00:00+09:00' });
  });

  it.each([
    ['2026-10-06', '2026-10-07'],
    ['2026-01-31', '2026-02-01'],
    ['2024-02-29', '2024-03-01'],
    ['2026-12-31', '2027-01-01'],
    ['0099-12-31', '0100-01-01'],
    ['9999-12-31', '10000-01-01'],
  ])('終了日%sは翌日%sの日本時間開始を除外境界にする', (to, nextDay) => {
    expect(notificationLogBounds({ from: to, to })).toEqual({
      from: `${to}T00:00:00+09:00`, toExclusive: `${nextDay}T00:00:00+09:00`,
    });
  });
});
