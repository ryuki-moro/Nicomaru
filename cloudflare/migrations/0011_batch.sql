-- 定期処理の実行記録 (6-12)。Supabase 版 batch_runs (20260828001200 + 20261009000400) の D1 版。
-- pg_cron 相当が無くても「動いていないのか 0 件なのか」を区別するため、開始/終了を必ず残す。
CREATE TABLE batch_runs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN (
    'risk_recalculate','notifications_dispatch','ai_job_reclaim','case_purge',
    'health_check','usage_rollup','monitoring','audit_log_purge','backup','rate_limit_cleanup'
  )),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  target_count INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  detail TEXT NOT NULL DEFAULT '{}',
  error_message TEXT
);
CREATE INDEX batch_runs_job_started ON batch_runs(job_type, started_at DESC);
