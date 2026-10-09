import type { SupabaseClient } from '@supabase/supabase-js';

import type { BatchOutcome } from '@/lib/api/internal';
import { capacityLimit, monitoredJobs } from './config';

export async function collectUsage(admin: SupabaseClient): Promise<BatchOutcome> {
  const parameters = {
    p_database_limit_bytes: capacityLimit(process.env.DB_CAPACITY_LIMIT_BYTES),
    p_storage_limit_bytes: capacityLimit(process.env.STORAGE_CAPACITY_LIMIT_BYTES),
  };
  try {
    // composite戻り値のRPCは単一行の応答を明示し、空結果や複数行も失敗にする。
    const { data, error } = await admin
      .rpc('collect_usage_snapshot', parameters)
      .single<{ measured_on: string }>();
    if (error || !data || typeof data.measured_on !== 'string') throw new Error();
    return { targetCount: 1, detail: { measuredOn: data.measured_on } };
  } catch {
    throw new Error('容量・利用状況の集計を保存できませんでした');
  }
}

export async function monitorSystem(admin: SupabaseClient): Promise<BatchOutcome> {
  const jobs = monitoredJobs();
  try {
    const { data, error } = await admin.rpc('evaluate_system_alerts', { p_expected_jobs: jobs });
    const row = data?.[0];
    if (
      error ||
      data?.length !== 1 ||
      !row ||
      ![row.active_count, row.published_count, row.resolved_count].every(
        (value) => Number.isInteger(value) && value >= 0,
      )
    ) {
      throw new Error();
    }
    return {
      targetCount: row.active_count,
      detail: {
        published: row.published_count,
        resolved: row.resolved_count,
        channel: 'system_admin_in_app',
      },
    };
  } catch {
    throw new Error('監視結果を保存できませんでした');
  }
}
