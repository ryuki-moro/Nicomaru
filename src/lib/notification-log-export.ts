/** CSV の期間は日本時間の暦日。終了日も含める（S03、#44）。 */
import { z } from 'zod';

import { badRequest } from '@/lib/errors';
import { toErrorDetails } from '@/lib/validation';

const calendarDate = z.iso
  .date({ error: '実在する日付をYYYY-MM-DDで指定してください' })
  .refine((value) => !value.startsWith('0000-'), '西暦1年以降の日付を指定してください');
const optionalDate = z.preprocess(
  (value) => (value === null || value === '' ? undefined : value),
  calendarDate.optional(),
);

export const notificationLogExportSchema = z
  .object({
    from: optionalDate,
    to: optionalDate,
  })
  .refine(({ from, to }) => !from || !to || from <= to, {
    path: ['to'],
    message: '終了日は開始日以降の日付を指定してください',
  });

export type NotificationLogPeriod = z.infer<typeof notificationLogExportSchema>;

export function parseNotificationLogPeriod(params: URLSearchParams): NotificationLogPeriod {
  const duplicates = (['from', 'to'] as const)
    .filter((field) => params.getAll(field).length > 1)
    .map((field) => ({ field, reason: '同じ項目を複数指定しないでください' }));
  if (duplicates.length > 0) throw badRequest(duplicates);

  const parsed = notificationLogExportSchema.safeParse({
    from: params.get('from'),
    to: params.get('to'),
  });
  if (!parsed.success) throw badRequest(toErrorDetails(parsed.error));
  return parsed.data;
}

export function notificationLogBounds(period: NotificationLogPeriod): {
  from?: string;
  toExclusive?: string;
} {
  let toExclusive: string | undefined;
  if (period.to) {
    const nextDay = new Date(`${period.to}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    // toISOString() の拡張年（+010000）は PostgreSQL の日時入力と互換でない。
    const day = [
      String(nextDay.getUTCFullYear()).padStart(4, '0'),
      String(nextDay.getUTCMonth() + 1).padStart(2, '0'),
      String(nextDay.getUTCDate()).padStart(2, '0'),
    ].join('-');
    toExclusive = `${day}T00:00:00+09:00`;
  }
  return {
    from: period.from ? `${period.from}T00:00:00+09:00` : undefined,
    toExclusive,
  };
}
