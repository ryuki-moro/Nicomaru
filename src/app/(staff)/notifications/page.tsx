/**
 * N01 通知履歴画面（planner／admin、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 N01／機能7-3。
 *
 *   「送信通知の履歴確認」
 *
 * 送信結果（notification_logs）まで出すのは 6-9 の
 * 「送信時は notifications に本文と状態を保存し、送信結果を notification_logs に保存する」
 * に対応する。とくに **LINE からメールへ切り替わった事実**を追えるようにしておく
 * （6-9「上限到達時はメールへ切り替えて送信し、切替をログに残す」）。
 *
 * 範囲は RLS（notifications_select）が担保する。planner は自担当案件、admin は自式場。
 */
import Link from 'next/link';

import { EmptyState } from '@/components/ui/EmptyState';
import { requireStaff } from '@/lib/auth/session';
import { CONTACT_CHANNEL_LABEL, LIST_PAGE_SIZE } from '@/lib/constants';
import { formatDateTime } from '@/lib/format';
import { NOTIFICATION_TYPE_LABEL, type NotificationType } from '@/lib/notify/templates';
import { resolvePage } from '@/lib/pagination';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/** 表6-9 に無い in_app を含むため、チャネル表示はここで補う。 */
const CHANNEL_LABEL: Record<string, string> = {
  ...CONTACT_CHANNEL_LABEL,
  in_app: 'マイページ内',
};

const STATUS_LABEL: Record<string, string> = {
  queued: '送信待ち',
  sent: '外部サービス受付済み／アプリ内掲載済み',
  failed: '送信失敗',
  read: '既読',
  cancelled: '取り消し',
  skipped: '送信見送り',
};

interface NotificationRow {
  id: string;
  case_id: string | null;
  channel: string;
  notification_type: NotificationType;
  title: string;
  status: string;
  sent_at: string | null;
  created_at: string;
  wedding_cases: { case_code: string } | null;
  notification_logs: { provider: string; status: string; attempt_no: number }[];
  notification_deliveries: {
    state: string;
    attempt_count: number;
    next_attempt_at: string;
    last_result: string | null;
  } | null;
}

interface Props {
  searchParams: Promise<{ page?: string | string[] }>;
}

export default async function NotificationHistoryPage({ searchParams }: Props) {
  await requireStaff();
  const params = await searchParams;
  const page = resolvePage(params.page);
  const offset = (page - 1) * LIST_PAGE_SIZE;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('notifications')
    .select(
      `id, case_id, channel, notification_type, title, status, sent_at, created_at,
       wedding_cases ( case_code ),
       notification_logs ( provider, status, attempt_no ),
       notification_deliveries ( state, attempt_count, next_attempt_at, last_result )`,
    )
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + LIST_PAGE_SIZE);

  const rows = (data ?? []) as unknown as NotificationRow[];
  const hasNext = rows.length > LIST_PAGE_SIZE;
  const visible = rows.slice(0, LIST_PAGE_SIZE);

  const linkTo = (next: number) => (next > 1 ? `/notifications?page=${next}` : '/notifications');

  return (
    <div className="space-y-4">
      <nav aria-label="パンくず">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li>
            <Link href="/dashboard" className="text-link hover:underline">
              ダッシュボード
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page">通知履歴</li>
        </ol>
      </nav>

      <h1 className="section-head">通知履歴</h1>
      <p className="text-caption text-text-muted">
        受付済みは配信サービスの受付を表し、到達・既読を保証しません。結果不明の通知は同じ送信キーで再確認し、期限を超えたものは自動再送せず要確認になります。
      </p>

      {error && (
        <div role="alert" className="banner-error">
          <span>通知履歴を取得できませんでした。時間をおいてお試しください。</span>
        </div>
      )}

      {!error && visible.length === 0 && <EmptyState message="送信した通知はまだありません。" />}

      {visible.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">日時</th>
                <th scope="col">案件番号</th>
                <th scope="col">種別</th>
                <th scope="col">件名</th>
                <th scope="col">チャネル</th>
                <th scope="col">状態</th>
                <th scope="col">送信結果</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.sent_at ?? row.created_at)}</td>
                  <td>
                    {row.case_id ? (
                      <Link href={`/cases/${row.case_id}`} className="text-link hover:underline">
                        {row.wedding_cases?.case_code ?? '—'}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{NOTIFICATION_TYPE_LABEL[row.notification_type]}</td>
                  <td>{row.title}</td>
                  <td>{CHANNEL_LABEL[row.channel] ?? row.channel}</td>
                  <td>
                    {row.status === 'read'
                      ? 'アプリ内で既読'
                      : (STATUS_LABEL[row.status] ?? row.status)}
                    {row.notification_deliveries && (
                      <p className="text-caption">
                        {
                          (
                            {
                              pending: '送信待ち',
                              processing: '送信処理中',
                              retry: '再試行待ち',
                              sent: '受付済み／掲載済み',
                              review: '要確認（自動再送停止）',
                              cancelled: '取り消し',
                            } as Record<string, string>
                          )[row.notification_deliveries.state]
                        }
                        {' / '}
                        {row.notification_deliveries.attempt_count}回試行
                        {row.notification_deliveries.last_result === 'unknown' &&
                          ' / 外部受付の結果不明'}
                        {row.notification_deliveries.last_result === 'legacy_unverified' &&
                          ' / 旧版の送信結果を確認してください'}
                        {row.notification_deliveries.state === 'retry' &&
                          ` / 次回 ${formatDateTime(row.notification_deliveries.next_attempt_at)}`}
                      </p>
                    )}
                  </td>
                  <td>
                    {row.notification_logs.length === 0
                      ? '—'
                      : row.notification_logs
                          .map(
                            (log) =>
                              `${CHANNEL_LABEL[log.provider] ?? log.provider}：` +
                              `${log.status === 'success' ? '受付済み' : '未受付／結果不明'}` +
                              (log.attempt_no > 1 ? `（${log.attempt_no}回目）` : ''),
                          )
                          .join(' / ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(page > 1 || hasNext) && (
        <div className="flex items-center justify-between">
          {page > 1 ? (
            <Link href={linkTo(page - 1)} className="btn-ghost">
              前のページ
            </Link>
          ) : (
            <span />
          )}
          {hasNext && (
            <Link href={linkTo(page + 1)} className="btn-ghost">
              次のページ
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
