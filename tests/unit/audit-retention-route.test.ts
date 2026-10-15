import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), rpc: vi.fn(), runBatch: vi.fn() }));
vi.mock('@/lib/supabase/admin', async (original) => ({
  ...(await original<typeof import('@/lib/supabase/admin')>()),
  createSupabaseAdminClient: mocks.admin,
}));
vi.mock('@/lib/api/internal', async (original) => ({
  ...(await original<typeof import('@/lib/api/internal')>()),
  runBatch: mocks.runBatch,
}));
import { POST } from '@/app/api/internal/audit-log-purge/route';

function request(secret = 'test-internal-secret') {
  return new Request('https://app.test/api/internal/audit-log-purge', {
    method: 'POST',
    headers: { 'x-internal-cron-secret': secret },
    body: '{"cutoff":"2100-01-01"}',
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('INTERNAL_CRON_SECRET', 'test-internal-secret');
  mocks.admin.mockReturnValue({ rpc: mocks.rpc });
  mocks.runBatch.mockImplementation(async (_admin, _type, fn) => fn());
  mocks.rpc.mockResolvedValue({
    data: [{ deleted_count: 2, cutoff: '2024-10-09T00:00:00Z' }],
    error: null,
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('監査保持バッチ入口', () => {
  it('内部secretを必須にし不正な呼出しではDBに触れない', async () => {
    expect((await POST(request('wrong'))).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('別バッチへ記録し、リクエスト指定の閾値を使わない', async () => {
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ removed: 2 });
    expect(mocks.admin).toHaveBeenCalledExactlyOnceWith('cron.audit-log-purge');
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('purge_expired_audit_logs');
    expect(mocks.runBatch.mock.calls[0][1]).toBe('audit_log_purge');
    expect(await mocks.runBatch.mock.results[0].value).toEqual({
      targetCount: 2,
      detail: { retentionYears: 2, cutoff: '2024-10-09T00:00:00Z' },
    });
  });
  it.each([
    { data: null, error: { message: 'private database detail' } },
    { data: [], error: null },
    { data: [{ deleted_count: -1, cutoff: '2024-10-09' }], error: null },
  ])('削除RPCの失敗や不正な件数を成功応答にしない', async (value) => {
    mocks.rpc.mockResolvedValue(value);
    expect((await POST(request())).status).toBe(500);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'private database detail',
    );
  });
});
