import { runBatch } from '@/lib/api/internal';
import { ok, route } from '@/lib/api/route';
import { usingD1 } from '@/lib/d1/mode';
import { monitorSystem } from '@/lib/monitoring/service';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

export const POST = route(
  async () => {
    if (usingD1()) {
      const { localDB } = await import('@/lib/d1/runtime');
      const { runBatchD1 } = await import('@/lib/d1/batches');
      const { monitorSystemD1 } = await import('@/lib/d1/monitoring');
      const db = await localDB();
      const result = await runBatchD1(db, 'monitoring', () => monitorSystemD1(db));
      return ok({ active: result.targetCount, ...result.detail });
    }
    const admin = createSupabaseAdminClient('cron.monitoring');
    const result = await runBatch(admin, 'monitoring', () => monitorSystem(admin));
    return ok({ active: result.targetCount, ...result.detail });
  },
  { source: 'internal-cron' },
);
