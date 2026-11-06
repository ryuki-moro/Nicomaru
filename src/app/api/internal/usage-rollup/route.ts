import { runBatch } from '@/lib/api/internal';
import { ok, route } from '@/lib/api/route';
import { usingD1 } from '@/lib/d1/mode';
import { collectUsage } from '@/lib/monitoring/service';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

export const POST = route(
  async () => {
    if (usingD1()) {
      const { localDB } = await import('@/lib/d1/runtime');
      const { runBatchD1 } = await import('@/lib/d1/batches');
      const { collectUsageD1 } = await import('@/lib/d1/monitoring');
      const db = await localDB();
      const result = await runBatchD1(db, 'usage_rollup', () => collectUsageD1(db));
      return ok({ measured: result.targetCount });
    }
    const admin = createSupabaseAdminClient('cron.usage-rollup');
    const result = await runBatch(admin, 'usage_rollup', () => collectUsage(admin));
    return ok({ measured: result.targetCount });
  },
  { source: 'internal-cron' },
);
