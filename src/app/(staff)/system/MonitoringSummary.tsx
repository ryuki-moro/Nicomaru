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
  checkedAt,
}: {
  snapshot: UsageSnapshot | null;
  failed: boolean;
  checkedAt: number;
}) {
  if (failed)
    return <p role="alert">容量集計を読み込めませんでした。時間をおいて再度ご確認ください。</p>;
  if (!snapshot) return <p>容量はまだ集計されていません。毎日の自動集計が動くと表示されます。</p>;
  const stale = checkedAt - Date.parse(snapshot.measured_at) > 2 * 86_400_000;
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
          label="ファイル保存領域"
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
        ファイル保存領域はアップロードされたファイルの合計、データベースは保存データの大きさです。
      </p>
    </div>
  );
}

function alertLabel(key: string): string {
  if (key.startsWith('batch_failed:')) return '自動処理が失敗しました';
  if (key.startsWith('batch_missing:')) return '自動処理が予定の2倍以上の時間、動いていません';
  const labels: Record<string, string> = {
    health_failed: 'サーバーの応答確認が続けて失敗しました',
    ai_failed: 'AIの処理に失敗したものがあります',
    ai_stalled: 'AIの処理が30分を超えて止まっています',
    notification_failures: '当日の通知送信失敗が5件以上あります',
    capacity_database: 'データベース使用量が設定上限の70%を超えています',
    capacity_storage: 'ファイル保存領域の使用量が設定上限の70%を超えています',
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
        システムが自動で見つけた問題です。同じ問題が続く間は1時間ごとにまとめ、直ると「解消済み」になります。
      </p>
      <details className="mt-1 text-caption text-text-muted">
        <summary className="cursor-pointer">技術担当の方へ</summary>
        この通知は画面内だけで、外部のメール・LINEには送りません。サーバー自体に接続できない障害は
        GitHub Actions の Keepalive で確認してください。
      </details>
      {failed ? (
        <p className="mt-2" role="alert">
          監視結果を読み込めませんでした。
        </p>
      ) : alerts.length === 0 ? (
        <p className="mt-2">
          確認が必要な問題はありません。下の「自動処理の実行結果」で、監視が動いていることも確認できます。
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
