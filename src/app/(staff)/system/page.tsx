/**
 * S03 利用状況・通知ログ画面（system_admin、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 S03／機能8-5／6-12。
 *
 *   「利用状況サマリー（式場数・案件数・利用者数・DB／Storage 使用量）、通知ログ一覧、
 *     定期処理の直近実行結果（6-12）を表示する」
 *   「ログをCSV出力」: 出力列は 日時／式場／案件番号／チャネル／種別／送信結果／
 *     プロバイダ側メッセージID。通知本文・氏名など個人情報を含む列は出力対象外とする
 *
 * DB／Storage の使用量は Supabase の管理API側の情報で、アプリのDBからは取れない。
 * 取れないものを 0 と表示すると「使っていない」と誤読されるため、
 * 取得元（Supabase ダッシュボード）を明示して数値は出さない。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/ui/EmptyState';
import { getAppUser } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { NOTIFICATION_TYPE_LABEL, type NotificationType } from '@/lib/notify/templates';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/** 6-12 表6-12 の処理名。batch_runs.job_type と対応する。 */
const JOB_LABEL: Record<string, string> = {
  risk_recalculate: 'リスク再計算',
  notifications_dispatch: '通知ディスパッチ',
  ai_job_reclaim: 'AIジョブの滞留回収',
  case_purge: '案件終了後の自動削除',
  health_check: '死活監視',
  usage_rollup: '容量・利用状況の集計',
  backup: 'バックアップ',
  rate_limit_cleanup: 'レート制限の掃除',
};

interface BatchRunRow {
  id: string;
  job_type: string;
  started_at: string;
  finished_at: string | null;
  target_count: number;
  http_status: number | null;
  error_message: string | null;
}

interface NotificationLogRow {
  id: string;
  provider: string;
  status: string;
  provider_message_id: string | null;
  created_at: string;
  notifications: {
    notification_type: NotificationType;
    case_id: string | null;
    venues: { name: string } | null;
    wedding_cases: { case_code: string } | null;
  } | null;
}

export default async function SystemStatusPage() {
  const user = await getAppUser();
  if (!user || user.role !== 'system_admin') redirect('/error?code=403');

  const supabase = await createSupabaseServerClient();

  const [venues, cases, users, batches, logs] = await Promise.all([
    supabase.from('venues').select('id', { count: 'exact', head: true }),
    supabase.from('wedding_cases').select('id', { count: 'exact', head: true }),
    supabase.from('user_profiles').select('id', { count: 'exact', head: true })
      .neq('status', 'deleted'),
    supabase.from('batch_runs')
      .select('id, job_type, started_at, finished_at, target_count, http_status, error_message')
      .order('started_at', { ascending: false })
      .limit(20),
    supabase.from('notification_logs')
      .select(
        `id, provider, status, provider_message_id, created_at,
         notifications ( notification_type, case_id,
                         venues ( name ), wedding_cases ( case_code ) )`,
      )
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  const batchRows = (batches.data ?? []) as unknown as BatchRunRow[];
  const logRows = (logs.data ?? []) as unknown as NotificationLogRow[];

  return (
    <div className="space-y-6">
      <nav aria-label="パンくず">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li aria-current="page">利用状況・通知ログ</li>
        </ol>
      </nav>

      <h1 className="section-head">利用状況・通知ログ</h1>

      <section>
        <h2 className="section-head">利用状況</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <Summary label="式場数" value={venues.count ?? 0} />
          <Summary label="案件数" value={cases.count ?? 0} />
          <Summary label="利用者数" value={users.count ?? 0} />
        </div>
        <p className="mt-2 text-caption text-text-muted">
          DB・Storage の使用量はアプリのデータベースからは取得できません。
          Supabase のダッシュボードでご確認ください（8-3 の有料移行判断に用います）。
        </p>
      </section>

      <section>
        <h2 className="section-head">定期処理の直近の実行結果</h2>
        <p className="mt-1 text-caption text-text-muted">
          pg_net は結果を待たずに送るため、失敗はこの記録でしか分かりません（6-12）。
        </p>
        {batchRows.length === 0 ? (
          <div className="mt-2"><EmptyState message="実行記録はまだありません。" /></div>
        ) : (
          <div className="table-wrap mt-2">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">処理</th>
                  <th scope="col">開始</th>
                  <th scope="col">終了</th>
                  <th scope="col">対象件数</th>
                  <th scope="col">結果</th>
                </tr>
              </thead>
              <tbody>
                {batchRows.map((row) => (
                  <tr key={row.id}>
                    <td>{JOB_LABEL[row.job_type] ?? row.job_type}</td>
                    <td>{formatDateTime(row.started_at)}</td>
                    <td>{row.finished_at ? formatDateTime(row.finished_at) : '実行中'}</td>
                    <td>{row.target_count}</td>
                    <td>
                      {row.http_status === 200
                        ? '成功'
                        : row.http_status === null
                          ? '—'
                          : `失敗（${row.error_message ?? row.http_status}）`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-head">通知ログ</h2>
          {/* 4-3 S03「ログをCSV出力」。個人情報を含む列は出力対象外（9章） */}
          <Link href="/api/system/notification-logs.csv" className="btn-ghost">
            ログをCSV出力
          </Link>
        </div>
        {logRows.length === 0 ? (
          <div className="mt-2"><EmptyState message="通知ログはまだありません。" /></div>
        ) : (
          <div className="table-wrap mt-2">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">日時</th>
                  <th scope="col">式場</th>
                  <th scope="col">案件番号</th>
                  <th scope="col">チャネル</th>
                  <th scope="col">種別</th>
                  <th scope="col">送信結果</th>
                </tr>
              </thead>
              <tbody>
                {logRows.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td>{row.notifications?.venues?.name ?? '—'}</td>
                    <td>{row.notifications?.wedding_cases?.case_code ?? '—'}</td>
                    <td>{row.provider === 'line' ? '公式LINE' : 'メール'}</td>
                    <td>
                      {row.notifications
                        ? NOTIFICATION_TYPE_LABEL[row.notifications.notification_type]
                        : '—'}
                    </td>
                    <td>{row.status === 'success' ? '成功' : '失敗'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <p className="text-caption text-text-muted">{label}</p>
      <p className="mt-1 text-title font-bold text-text-primary">{value}</p>
    </div>
  );
}
