import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { capacityLimit, monitoredJobs } from '@/lib/monitoring/config';
import { collectUsage, monitorSystem } from '@/lib/monitoring/service';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('監視設定', () => {
  it('容量未設定をnullに保ち、正の整数だけを許可する', () => {
    expect(capacityLimit(undefined)).toBeNull();
    expect(capacityLimit('')).toBeNull();
    expect(capacityLimit('100')).toBe(100);
    for (const value of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
      expect(() => capacityLimit(value)).toThrow();
    }
  });
  it('有効化した既知のジョブだけを監視する', () => {
    expect(monitoredJobs('usage_rollup,ai_job_reclaim, usage_rollup')).toEqual({
      usage_rollup: 86400,
      ai_job_reclaim: 600,
    });
    expect(monitoredJobs('')).toEqual({});
    expect(() => monitoredJobs('unknown')).toThrow();
  });
});

describe('内部バッチの集計と監視', () => {
  it('容量の設定をRPCへ渡し、集計対象の本文は記録しない', async () => {
    vi.stubEnv('DB_CAPACITY_LIMIT_BYTES', '100');
    vi.stubEnv('STORAGE_CAPACITY_LIMIT_BYTES', '');
    const rpc = vi
      .fn()
      .mockReturnValue({
        single: vi
          .fn()
          .mockResolvedValue({
            data: { measured_on: '2026-10-09', secret: 'not-logged' },
            error: null,
          }),
      });
    expect(await collectUsage({ rpc } as unknown as SupabaseClient)).toEqual({
      targetCount: 1,
      detail: { measuredOn: '2026-10-09' },
    });
    expect(rpc).toHaveBeenCalledWith('collect_usage_snapshot', {
      p_database_limit_bytes: 100,
      p_storage_limit_bytes: null,
    });
  });
  it('集計・記録失敗を成功扱いせず、上流エラーの個人情報を露出しない', async () => {
    const failed = { data: null, error: { message: 'sensitive-data' } };
    const rpc = vi
      .fn()
      .mockReturnValue({
        single: vi.fn().mockResolvedValue(failed),
        then: (resolve: (value: unknown) => void) => resolve(failed),
      });
    const admin = { rpc } as unknown as SupabaseClient;
    await expect(collectUsage(admin)).rejects.toThrow('容量・利用状況の集計を保存できませんでした');
    await expect(monitorSystem(admin)).rejects.toThrow('監視結果を保存できませんでした');
  });
  it('内部通知の新規・解消件数を実行記録へ返す', async () => {
    vi.stubEnv('MONITOR_ENABLED_JOBS', 'usage_rollup');
    const rpc = vi
      .fn()
      .mockResolvedValue({
        data: [{ active_count: 2, published_count: 1, resolved_count: 3 }],
        error: null,
      });
    expect(await monitorSystem({ rpc } as unknown as SupabaseClient)).toEqual({
      targetCount: 2,
      detail: { published: 1, resolved: 3, channel: 'system_admin_in_app' },
    });
    expect(rpc).toHaveBeenCalledWith('evaluate_system_alerts', {
      p_expected_jobs: { usage_rollup: 86400 },
    });
  });
  it('容量設定に誤りがある場合はRPCを呼ばない', async () => {
    vi.stubEnv('DB_CAPACITY_LIMIT_BYTES', '-1');
    const rpc = vi.fn();
    await expect(collectUsage({ rpc } as unknown as SupabaseClient)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('空や不完全なRPC結果を成功として記録しない', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{}], error: null });
    await expect(monitorSystem({ rpc } as unknown as SupabaseClient)).rejects.toThrow(
      '監視結果を保存できませんでした',
    );
    rpc.mockReturnValue({ single: vi.fn().mockResolvedValue({ data: {}, error: null }) });
    await expect(collectUsage({ rpc } as unknown as SupabaseClient)).rejects.toThrow(
      '容量・利用状況の集計を保存できませんでした',
    );
  });
});
