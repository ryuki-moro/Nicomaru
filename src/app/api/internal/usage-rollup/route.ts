import { ok, route } from '@/lib/api/route';
export const runtime = 'nodejs';
export const POST = route(
  async () => {
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { runBatchD1 } = await import('@/lib/d1/batches');
      const { collectUsageD1 } = await import('@/lib/d1/monitoring');
      const db = await localDB();
      const result = await runBatchD1(db, 'usage_rollup', () => collectUsageD1(db));
      return ok({ measured: result.targetCount });
    }
  },
  { source: 'internal-cron' },
);
