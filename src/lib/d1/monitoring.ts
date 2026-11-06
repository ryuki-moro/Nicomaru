/**
 * 容量集計 (usage_rollup) と障害条件の監視 (monitoring) の D1 版 (6-12 / GAP-03・04)。
 * Supabase 版 src/lib/monitoring/service.ts の RPC 2 本を、D1 では通常の集計クエリで再表現する。
 */
import type { D1Database } from '@cloudflare/workers-types';

import type { BatchOutcome } from '@/lib/api/internal';
import { capacityLimit, monitoredJobs } from '@/lib/monitoring/config';
import { todayInJst } from '@/lib/format';

const count = async (db: D1Database, sql: string, ...binds: unknown[]) => {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

/** JST の当日開始を UTC ISO で返す (D1 の created_at は UTC ISO で保存されるため文字列比較を揃える)。 */
function jstDayStartIso(on: string): string {
  return new Date(`${on}T00:00:00+09:00`).toISOString();
}

export async function collectUsageD1(db: D1Database): Promise<BatchOutcome> {
  const measuredOn = todayInJst();
  const measuredAt = new Date().toISOString();
  const dayStart = jstDayStartIso(measuredOn);
  const nextDay = new Date(Date.parse(dayStart) + 86_400_000).toISOString();

  // D1 に物理サイズ API は無い。SQLite のページ数 × ページサイズを概算として記録する。
  let databaseBytes = 0;
  try {
    const pragma = await db
      .prepare(
        'SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()',
      )
      .first<{ bytes: number }>();
    databaseBytes = pragma?.bytes ?? 0;
  } catch {
    databaseBytes = 0;
  }
  const storage = await db
    .prepare('SELECT count(*) AS n, COALESCE(SUM(file_size_bytes),0) AS bytes FROM storage_files')
    .first<{ n: number; bytes: number }>();

  const snapshot = {
    venueCount: await count(db, 'SELECT count(*) AS n FROM venues'),
    caseCount: await count(db, 'SELECT count(*) AS n FROM wedding_cases'),
    userCount: await count(db, "SELECT count(*) AS n FROM user_profiles WHERE status<>'deleted'"),
    fileCount: storage?.n ?? 0,
    notificationCount: await count(
      db,
      'SELECT count(*) AS n FROM notifications WHERE created_at>=? AND created_at<?',
      dayStart,
      nextDay,
    ),
    notificationFailureCount: await count(
      db,
      "SELECT count(*) AS n FROM notification_logs WHERE status='failure' AND created_at>=? AND created_at<?",
      dayStart,
      nextDay,
    ),
  };

  await db
    .prepare(
      `INSERT INTO usage_snapshots(measured_on,measured_at,database_bytes,storage_bytes,database_limit_bytes,storage_limit_bytes,venue_count,case_count,user_count,file_count,notification_count,notification_failure_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(measured_on) DO UPDATE SET measured_at=excluded.measured_at,database_bytes=excluded.database_bytes,storage_bytes=excluded.storage_bytes,database_limit_bytes=excluded.database_limit_bytes,storage_limit_bytes=excluded.storage_limit_bytes,venue_count=excluded.venue_count,case_count=excluded.case_count,user_count=excluded.user_count,file_count=excluded.file_count,notification_count=excluded.notification_count,notification_failure_count=excluded.notification_failure_count`,
    )
    .bind(
      measuredOn,
      measuredAt,
      databaseBytes,
      storage?.bytes ?? 0,
      capacityLimit(process.env.DB_CAPACITY_LIMIT_BYTES),
      capacityLimit(process.env.STORAGE_CAPACITY_LIMIT_BYTES),
      snapshot.venueCount,
      snapshot.caseCount,
      snapshot.userCount,
      snapshot.fileCount,
      snapshot.notificationCount,
      snapshot.notificationFailureCount,
    )
    .run();
  return { targetCount: 1, detail: { measuredOn } };
}

export interface SystemAlertRow {
  alert_key: string;
  source: string;
  affected_count: number;
  last_detected_at: string;
  published_at: string;
  resolved_at: string | null;
}

export async function latestUsageSnapshot(db: D1Database) {
  return db
    .prepare('SELECT * FROM usage_snapshots ORDER BY measured_at DESC LIMIT 1')
    .first<Record<string, unknown>>();
}

export async function listSystemAlerts(db: D1Database, limit = 50): Promise<SystemAlertRow[]> {
  const { results } = await db
    .prepare(
      'SELECT alert_key,source,affected_count,last_detected_at,published_at,resolved_at FROM system_alerts ORDER BY resolved_at IS NOT NULL, last_detected_at DESC LIMIT ?',
    )
    .bind(limit)
    .all<SystemAlertRow>();
  return results;
}

interface Candidate {
  key: string;
  category: string;
  source: string;
  count: number;
}

/** Supabase 版 evaluate_system_alerts と同じ候補条件で system_alerts を更新する。 */
export async function monitorSystemD1(db: D1Database, now = new Date()): Promise<BatchOutcome> {
  const nowIso = now.toISOString();
  const jobs = monitoredJobs();
  const candidates: Candidate[] = [];

  const baselineRow = await db
    .prepare("SELECT MIN(started_at) AS t FROM batch_runs WHERE job_type='monitoring'")
    .first<{ t: string | null }>();
  const baseline = baselineRow?.t ?? nowIso;

  for (const [job, intervalSec] of Object.entries(jobs)) {
    const last = await db
      .prepare(
        'SELECT started_at,http_status FROM batch_runs WHERE job_type=? AND started_at<=? ORDER BY started_at DESC,id DESC LIMIT 1',
      )
      .bind(job, nowIso)
      .first<{ started_at: string; http_status: number | null }>();
    if (last && last.http_status !== null && last.http_status >= 400)
      candidates.push({ key: `batch_failed:${job}`, category: 'batch', source: job, count: 1 });
    const lastStart = last?.started_at ?? baseline;
    if (Date.parse(lastStart) < now.getTime() - intervalSec * 2 * 1000)
      candidates.push({ key: `batch_missing:${job}`, category: 'batch', source: job, count: 1 });
  }

  const healthFailures = await count(
    db,
    "SELECT count(*) AS n FROM (SELECT http_status FROM batch_runs WHERE job_type='health_check' AND finished_at IS NOT NULL AND started_at<=? ORDER BY started_at DESC,id DESC LIMIT 2) WHERE http_status>=400",
    nowIso,
  );
  if (healthFailures >= 2)
    candidates.push({
      key: 'health_failed',
      category: 'health',
      source: 'health_check',
      count: healthFailures,
    });

  const aiFailed = await count(db, "SELECT count(*) AS n FROM ai_jobs WHERE status='failed'");
  if (aiFailed > 0)
    candidates.push({ key: 'ai_failed', category: 'ai', source: 'ai_jobs', count: aiFailed });
  const aiStalled = await count(
    db,
    "SELECT count(*) AS n FROM ai_jobs WHERE status='processing' AND COALESCE(locked_at,started_at,created_at)<?",
    new Date(now.getTime() - 30 * 60_000).toISOString(),
  );
  if (aiStalled > 0)
    candidates.push({ key: 'ai_stalled', category: 'ai', source: 'ai_jobs', count: aiStalled });

  const today = todayInJst(now);
  const dayStart = jstDayStartIso(today);
  const nextDay = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  const notifFailures = await count(
    db,
    "SELECT count(*) AS n FROM notification_logs WHERE status='failure' AND created_at>=? AND created_at<? AND created_at<=?",
    dayStart,
    nextDay,
    nowIso,
  );
  if (notifFailures >= 5)
    candidates.push({
      key: 'notification_failures',
      category: 'notification',
      source: 'notification_logs',
      count: notifFailures,
    });

  const snapshot = await latestUsageSnapshot(db);
  const measuredAt = snapshot?.measured_at as string | null | undefined;
  const fresh = measuredAt != null && Date.parse(measuredAt) >= now.getTime() - 2 * 86_400_000;
  if (
    !fresh ||
    snapshot?.database_limit_bytes == null ||
    snapshot?.storage_limit_bytes == null ||
    snapshot?.storage_bytes == null
  )
    candidates.push({
      key: 'capacity_unavailable',
      category: 'capacity',
      source: 'usage_snapshot',
      count: 1,
    });
  if (fresh) {
    const dbBytes = Number(snapshot?.database_bytes ?? 0);
    const dbLimit = snapshot?.database_limit_bytes as number | null;
    if (dbLimit != null && dbBytes > dbLimit * 0.7)
      candidates.push({
        key: 'capacity_database',
        category: 'capacity',
        source: 'database',
        count: dbBytes,
      });
    const stBytes = snapshot?.storage_bytes as number | null;
    const stLimit = snapshot?.storage_limit_bytes as number | null;
    if (stBytes != null && stLimit != null && stBytes > stLimit * 0.7)
      candidates.push({
        key: 'capacity_storage',
        category: 'capacity',
        source: 'storage',
        count: stBytes,
      });
  }

  // D1 の監査には Supabase 版の集約行 (auth.login_failures) は無いため、行が無ければ 0 件で素通りする。
  const authFailures = await count(
    db,
    "SELECT count(*) AS n FROM audit_logs WHERE action='auth.login_failures' AND created_at>? AND created_at<=?",
    new Date(now.getTime() - 3_600_000).toISOString(),
    nowIso,
  ).catch(() => 0);
  if (authFailures > 0)
    candidates.push({
      key: 'auth_failures',
      category: 'auth',
      source: 'auth',
      count: authFailures,
    });

  let published = 0;
  const keys: string[] = [];
  for (const c of candidates) {
    keys.push(c.key);
    const old = await db
      .prepare('SELECT resolved_at,published_at FROM system_alerts WHERE alert_key=?')
      .bind(c.key)
      .first<{ resolved_at: string | null; published_at: string }>();
    if (!old) {
      await db
        .prepare(
          'INSERT INTO system_alerts(alert_key,category,source,affected_count,first_detected_at,last_detected_at,published_at) VALUES (?,?,?,?,?,?,?)',
        )
        .bind(c.key, c.category, c.source, c.count, nowIso, nowIso, nowIso)
        .run();
      published += 1;
    } else {
      const republish =
        old.resolved_at !== null || Date.parse(old.published_at) <= now.getTime() - 3_600_000;
      await db
        .prepare(
          `UPDATE system_alerts SET affected_count=?,last_detected_at=?,resolved_at=NULL,
             first_detected_at=CASE WHEN resolved_at IS NOT NULL THEN ? ELSE first_detected_at END,
             published_at=CASE WHEN ? THEN ? ELSE published_at END,
             occurrence_count=occurrence_count + CASE WHEN ? THEN 1 ELSE 0 END
           WHERE alert_key=?`,
        )
        .bind(c.count, nowIso, nowIso, republish ? 1 : 0, nowIso, republish ? 1 : 0, c.key)
        .run();
      if (republish) published += 1;
    }
  }
  let resolved = 0;
  if (keys.length) {
    const r = await db
      .prepare(
        `UPDATE system_alerts SET resolved_at=? WHERE resolved_at IS NULL AND alert_key NOT IN (${keys.map(() => '?').join(',')})`,
      )
      .bind(nowIso, ...keys)
      .run();
    resolved = r.meta.changes ?? 0;
  } else {
    const r = await db
      .prepare('UPDATE system_alerts SET resolved_at=? WHERE resolved_at IS NULL')
      .bind(nowIso)
      .run();
    resolved = r.meta.changes ?? 0;
  }
  return {
    targetCount: keys.length,
    detail: { published, resolved, channel: 'system_admin_in_app' },
  };
}
