import { runBatch } from '@/lib/api/internal';
import { ok, route } from '@/lib/api/route';
import { monitorSystem } from '@/lib/monitoring/service';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

export const POST = route(
  async () => {
    const admin = createSupabaseAdminClient('cron.monitoring');
    const result = await runBatch(admin, 'monitoring', () => monitorSystem(admin));
    return ok({ active: result.targetCount, ...result.detail });
  },
  { source: 'internal-cron' },
);
