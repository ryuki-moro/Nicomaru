import { formatDateTime } from '@/lib/format';

export interface UsageSnapshot {
  measured_on: string;
  measured_at: string;
  database_bytes: number;
  storage_bytes: number | null;
  database_limit_bytes: number | null;
  storage_limit_bytes: number | null;
  file_count: number;
  notification_count: number;
  notification_failure_count: number;
}

export interface SystemAlert {
  alert_key: string;
  source: string;
  affected_count: number;
  last_detected_at: string;
  published_at: string;
  resolved_at: string | null;
}

function bytesLabel(bytes: number): string {
  return `${(bytes / 1024 / 1024).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} MiB`;
}

function Capacity({
  label,
  used,
  limit,
}: {
  label: string;
  used: number | null;
  limit: number | null;
}) {
  const exceeded = used !== null && limit !== null && used > limit * 0.7;
  return (
    <div className="card">
      <p className="font-semibold">{label}</p>
      <p className="mt-1">{used === null ? '使用量を取得できていません' : bytesLabel(used)}</p>
      <p className="text-caption text-text-muted">
        {limit === null ? '容量上限が未設定です' : `設定上限 ${bytesLabel(limit)}`}
      </p>
      {used !== null && limit !== null && (
        <p className="mt-1 font-semibold">
          使用率 {((used / limit) * 100).toFixed(1)}%{exceeded ? ' — 70%を超えています' : ''}
        </p>
      )}
    </div>
  );
}

export function UsageSummary({
  snapshot,
  failed,
}: {
  snapshot: UsageSnapshot | null;
  failed: boolean;
}) {
  if (failed)
    return <p role="alert">容量集計を読み込めませんでした。時間をおいて再度ご確認ください。</p>;
  if (!snapshot)
    return <p>容量の集計記録はまだありません。日次集計の設定・実行状況をご確認ください。</p>;
  const stale = Date.now() - Date.parse(snapshot.measured_at) > 2 * 86_400_000;
  return (
    <div className="mt-3 space-y-2">
      <p className="text-caption text-text-muted">
        最終集計: {formatDateTime(snapshot.measured_at)}（日付は日本時間）
      </p>
      {stale && <p role="alert">集計から2日以上経過しています。現在の使用量を判断できません。</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Capacity
          label="データベース"
          used={snapshot.database_bytes}
          limit={snapshot.database_limit_bytes}
        />
        <Capacity
          label="Storage"
          used={snapshot.storage_bytes}
          limit={snapshot.storage_limit_bytes}
        />
      </div>
      <p className="text-caption text-text-muted">
        提出ファイル {snapshot.file_count} 件 / 当日の通知作成 {snapshot.notification_count} 件 /
        当日の送信失敗 {snapshot.notification_failure_count} 件
      </p>
      <p className="text-caption text-text-muted">
        使用率は設定した容量上限との比較です。契約プランの上限変更時は設定を更新してください。
        Storageはプロジェクト内のオブジェクトの合計、データベースは物理サイズです。
      </p>
    </div>
  );
}

function alertLabel(key: string): string {
  if (key.startsWith('batch_failed:')) return '定期処理が失敗しました';
  if (key.startsWith('batch_missing:')) return '定期処理が想定間隔の2倍を超えて未実行です';
  const labels: Record<string, string> = {
    health_failed: '死活監視が連続で失敗しました',
    ai_failed: 'AIジョブに失敗があります',
    ai_stalled: 'AIジョブの処理が30分を超えています',
    notification_failures: '当日の通知送信失敗が5件以上あります',
    capacity_database: 'データベース使用量が設定上限の70%を超えています',
    capacity_storage: 'Storage使用量が設定上限の70%を超えています',
    capacity_unavailable: '容量集計の未取得・期限切れ・上限未設定を確認してください',
    auth_failures: '同一アカウントへの認証失敗が1時間に10回以上発生しました',
  };
  return labels[key] ?? '確認が必要な項目があります';
}

export function MonitoringSummary({ alerts, failed }: { alerts: SystemAlert[]; failed: boolean }) {
  return (
    <section>
      <h2 className="section-head">システムの確認事項</h2>
      <p className="mt-1 text-caption text-text-muted">
        システム管理者の共通通知です。継続する同じ問題の再通知は1時間ごとにまとめ、回復時に解消と表示します。
        外部のメール・LINEには送信しません。サーバーに接続できない障害はGitHub
        ActionsのKeepaliveで確認してください。
      </p>
      {failed ? (
        <p className="mt-2" role="alert">
          監視結果を読み込めませんでした。
        </p>
      ) : alerts.length === 0 ? (
        <p className="mt-2">
          通知記録はまだありません。下の定期処理一覧で監視が実行されていることをご確認ください。
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {alerts.map((alert) => (
            <li key={alert.alert_key} className="card">
              <p className="font-semibold">
                {alert.resolved_at ? '解消済み' : '要確認'}: {alertLabel(alert.alert_key)}
              </p>
              <p className="mt-1 text-caption text-text-muted">
                対象: {alert.source} / 最終検知: {formatDateTime(alert.last_detected_at)}
                {alert.resolved_at && ` / 解消: ${formatDateTime(alert.resolved_at)}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
