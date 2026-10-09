/** 6-12の定期実行間隔（秒）。有効化した処理だけを未実行監視する。 */
export const BATCH_INTERVAL_SECONDS = {
  risk_recalculate: 86_400,
  notifications_dispatch: 86_400,
  case_purge: 86_400,
  rate_limit_cleanup: 86_400,
  usage_rollup: 86_400,
  audit_log_purge: 86_400,
  ai_job_reclaim: 600,
  monitoring: 600,
  health_check: 21_600,
  backup: 86_400,
} as const;

const DEFAULT_JOBS = [
  'risk_recalculate',
  'notifications_dispatch',
  'case_purge',
  'rate_limit_cleanup',
  'usage_rollup',
  'audit_log_purge',
  'ai_job_reclaim',
] as const;

export function monitoredJobs(value = process.env.MONITOR_ENABLED_JOBS): Record<string, number> {
  const jobs =
    value === undefined
      ? DEFAULT_JOBS
      : value
          .split(',')
          .map((job) => job.trim())
          .filter(Boolean);
  const result: Record<string, number> = {};
  for (const job of jobs) {
    if (!Object.hasOwn(BATCH_INTERVAL_SECONDS, job)) {
      throw new Error('MONITOR_ENABLED_JOBS に未対応の処理名が設定されています');
    }
    result[job] = BATCH_INTERVAL_SECONDS[job as keyof typeof BATCH_INTERVAL_SECONDS];
  }
  return result;
}

/** プラン変更時は設定だけを変更する。未設定を容量0や使用率0%に変換しない。 */
export function capacityLimit(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  if (!/^\d+$/.test(value)) throw new Error('容量上限には正の整数を設定してください');
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error('容量上限には正の整数を設定してください');
  return bytes;
}
