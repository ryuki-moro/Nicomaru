/** S03 の通知ログCSV。RLS適用クライアントで最大10,001件を取得する（#45）。 */
import { CSV_MAX_ROWS } from '@/lib/csv';
import { fromPostgresError } from '@/lib/errors';
import { notificationLogBounds, type NotificationLogPeriod } from '@/lib/notification-log-export';
import type { NotificationType } from '@/lib/notify/templates';
import type { SupabaseServerClient } from '@/lib/supabase/server';

const PAGE_SIZE = 1000;
const EXPORT_COLUMNS = `id, provider, status, provider_message_id, created_at,
  notifications ( notification_type, venues ( name ), wedding_cases ( case_code ) )`;

export interface NotificationLogExportRow {
  id: string;
  provider: 'line' | 'email';
  status: 'success' | 'failure';
  provider_message_id: string | null;
  created_at: string;
  notifications: {
    notification_type: NotificationType;
    venues: { name: string } | null;
    wedding_cases: { case_code: string } | null;
  } | null;
}

/** or() は値をエスケープしないので、DBから得たカーソルも引用する。 */
function quoteFilterValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export async function loadNotificationLogsForExport(
  supabase: SupabaseServerClient,
  period: NotificationLogPeriod = {},
): Promise<NotificationLogExportRow[]> {
  const bounds = notificationLogBounds(period);
  const rows: NotificationLogExportRow[] = [];
  let cursor: NotificationLogExportRow | undefined;

  while (rows.length < CSV_MAX_ROWS + 1) {
    let query = supabase
      .from('notification_logs')
      .select(EXPORT_COLUMNS)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(Math.min(PAGE_SIZE, CSV_MAX_ROWS + 1 - rows.length));
    if (bounds.from) query = query.gte('created_at', bounds.from);
    if (bounds.toExclusive) query = query.lt('created_at', bounds.toExclusive);
    if (cursor) {
      // JS Dateを経由せず、DBのマイクロ秒精度を維持する。同時刻はUUIDで送る。
      const time = quoteFilterValue(cursor.created_at);
      const id = quoteFilterValue(cursor.id);
      query = query.or(`created_at.lt.${time},and(created_at.eq.${time},id.lt.${id})`);
    }

    const { data, error } = await query;
    if (error) throw fromPostgresError(error);
    const batch = (data ?? []) as unknown as NotificationLogExportRow[];
    if (batch.length === 0) break;
    rows.push(...batch);
    cursor = batch[batch.length - 1];
    // 短いページでも続ける。サーバーの取得上限がPAGE_SIZEより低い場合も欠落させない。
  }
  return rows;
}
