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
import { CSV_MAX_ROWS, buildCsv } from '@/lib/csv';
import { fromPostgresError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { NOTIFICATION_TYPE_LABEL, type NotificationType } from '@/lib/notify/templates';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

interface LogRow {
  provider: string;
  status: string;
  provider_message_id: string | null;
  created_at: string;
  notifications: {
    notification_type: NotificationType;
    venues: { name: string } | null;
    wedding_cases: { case_code: string } | null;
  } | null;
}

export const GET = route(async (request: Request) => {
  await requireRole('system_admin');

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('notification_logs')
    .select(
      `provider, status, provider_message_id, created_at,
       notifications ( notification_type, venues ( name ), wedding_cases ( case_code ) )`,
    )
    .order('created_at', { ascending: false })
    // 上限に達したかを判定するため1件多く取る
    .limit(CSV_MAX_ROWS + 1);

  // 「超過分は期間を絞る」ための入口（4-3 S03）
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);

  const { data, error } = await query;
  if (error) throw fromPostgresError(error);

  const rows = (data ?? []) as unknown as LogRow[];
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
      // 切り詰めた事実を画面ではなくヘッダーで伝える（本文はCSVそのものなので混ぜられない）
      'x-truncated': String(csv.truncated),
    },
  });
});
