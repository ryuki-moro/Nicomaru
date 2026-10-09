/**
 * GET /api/system/notification-logs.csv — 通知ログのCSV出力（4-3 S03、機能8-5、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 S03／第9章「CSV出力対策」。
 *
 *   出力列: 日時／式場／案件番号／チャネル／種別／送信結果／プロバイダ側メッセージID
 *   文字コード: UTF-8（BOM付き）、最大10,000件（超過分は期間を絞る）
 *   **通知本文・氏名など個人情報を含む列は出力対象外**
 *   先頭が = + - @ タブ CR の値をエスケープする
 *
 * 個人情報を出さないのは 9章の方針であり、S03 の目的（利用状況の把握）に本文は要らないため。
 */
import { requireRole } from '@/lib/auth/session';
import { route } from '@/lib/api/route';
import { buildCsv } from '@/lib/csv';
import { formatDateTime } from '@/lib/format';
import { parseNotificationLogPeriod } from '@/lib/notification-log-export';
import { NOTIFICATION_TYPE_LABEL } from '@/lib/notify/templates';
import { loadNotificationLogsForExport } from '@/lib/services/notification-log-export';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = route(async (request: Request) => {
  await requireRole('system_admin');
  const period = parseNotificationLogPeriod(new URL(request.url).searchParams);
  const supabase = await createSupabaseServerClient();
  const rows = await loadNotificationLogsForExport(supabase, period);
  const csv = buildCsv(
    ['日時', '式場', '案件番号', 'チャネル', '種別', '送信結果', 'プロバイダ側メッセージID'],
    rows.map((row) => [
      formatDateTime(row.created_at),
      row.notifications?.venues?.name ?? '',
      row.notifications?.wedding_cases?.case_code ?? '',
      row.provider === 'line' ? '公式LINE' : 'メール',
      row.notifications ? NOTIFICATION_TYPE_LABEL[row.notifications.notification_type] : '',
      row.status === 'success' ? '成功' : '失敗',
      row.provider_message_id ?? '',
    ]),
  );

  return new Response(csv.content, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="notification-logs.csv"',
      'cache-control': 'private, no-store',
      // CSVの本文を変えず、画面が上限超過の案内に使えるようヘッダーで伝える。
      'x-truncated': String(csv.truncated),
    },
  });
});
