import { runBatch } from '@/lib/api/internal';
import { ok, route } from '@/lib/api/route';
import { collectUsage } from '@/lib/monitoring/service';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

export const POST = route(
  async () => {
    const admin = createSupabaseAdminClient('cron.usage-rollup');
    const result = await runBatch(admin, 'usage_rollup', () => collectUsage(admin));
    return ok({ measured: result.targetCount });
  },
  { source: 'internal-cron' },
);
