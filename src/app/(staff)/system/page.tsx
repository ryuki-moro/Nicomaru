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
 * 容量は内部バッチが採取した日次スナップショットを表示する。
 * 未取得・上限未設定・集計の期限切れは0%や正常として表示しない。
 */
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { EmptyState } from '@/components/ui/EmptyState';
import { getAppUser } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { NOTIFICATION_TYPE_LABEL, type NotificationType } from '@/lib/notify/templates';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  MonitoringSummary,
  UsageSummary,
  type SystemAlert,
  type UsageSnapshot,
} from './MonitoringSummary';
import { NotificationLogExportForm } from './NotificationLogExportForm';
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
  audit_log_purge: '監査ログの保持期限処理',
  monitoring: '障害条件の監視',
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
    venues: {
      name: string;
    } | null;
    wedding_cases: {
      case_code: string;
    } | null;
  } | null;
}
// 動的なサーバーリクエストの時刻を、表示コンポーネントへの入力として固定する。
function requestTime(): number {
  return Date.now();
}
export default async function SystemStatusPage() {
  const user = await getAppUser();
  if (!user || user.role !== 'system_admin') redirect('/error?code=403');
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const { systemSummaryD1 } = await import('@/lib/d1/admin');
    const summary = await systemSummaryD1(await localDB(), user);
    const checkedAtD1 = requestTime();
    return (
      <SystemView
        venueCount={summary.venueCount}
        caseCount={summary.caseCount}
        userCount={summary.userCount}
        batchRows={summary.batches as BatchRunRow[]}
        logRows={summary.logs as unknown as NotificationLogRow[]}
        usage={summary.usage as UsageSnapshot | null}
        usageFailed={false}
        alerts={summary.alerts as SystemAlert[]}
        alertsFailed={false}
        checkedAt={checkedAtD1}
      />
    );
  }
}
function SystemView(props: {
  venueCount: number | null;
  caseCount: number | null;
  userCount: number | null;
  batchRows: BatchRunRow[];
  batchesFailed?: boolean;
  logRows: NotificationLogRow[];
  logsFailed?: boolean;
  usage: UsageSnapshot | null;
  usageFailed: boolean;
  alerts: SystemAlert[];
  alertsFailed: boolean;
  checkedAt: number;
}) {
  const { batchRows, logRows } = props;
  return (
    <div className="space-y-6">
      <Breadcrumbs items={[{ label: '利用状況・通知ログ' }]} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="section-head">利用状況・通知ログ</h1>
        <Link href="/venues" className="btn-secondary w-auto px-5 text-center">
          式場一覧
        </Link>
      </div>

      <section>
        <h2 className="section-head">利用状況</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <Summary label="式場数" value={props.venueCount} />
          <Summary label="案件数" value={props.caseCount} />
          <Summary label="利用者数" value={props.userCount} />
        </div>
        <UsageSummary
          snapshot={props.usage}
          failed={props.usageFailed}
          checkedAt={props.checkedAt}
        />
      </section>

      <MonitoringSummary alerts={props.alerts} failed={props.alertsFailed} />

      <section>
        <h2 className="section-head">定期処理の直近の実行結果</h2>
        <p className="mt-1 text-caption text-text-muted">
          pg_net は結果を待たずに送るため、失敗はこの記録でしか分かりません。
        </p>
        {props.batchesFailed ? (
          <p className="mt-2" role="alert">
            実行記録を読み込めませんでした。
          </p>
        ) : batchRows.length === 0 ? (
          <div className="mt-2">
            <EmptyState message="実行記録はまだありません。" />
          </div>
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
        <h2 className="section-head">通知ログ</h2>
        <NotificationLogExportForm />
        {props.logsFailed ? (
          <p className="mt-2" role="alert">
            通知ログを読み込めませんでした。
          </p>
        ) : logRows.length === 0 ? (
          <div className="mt-2">
            <EmptyState message="通知ログはまだありません。" />
          </div>
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
function Summary({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="card">
      <p className="text-caption text-text-muted">{label}</p>
      <p className="mt-1 text-title font-bold text-text-primary">
        {value ?? '取得できませんでした'}
      </p>
    </div>
  );
}
