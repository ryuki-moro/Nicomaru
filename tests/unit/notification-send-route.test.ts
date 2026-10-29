import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { staff, admin, dispatch } = vi.hoisted(() => ({
  staff: vi.fn(),
  admin: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({ requireStaff: async () => ({ displayName: '担当者' }) }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: staff }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: admin }));
vi.mock('@/lib/services/notifications', () => ({ dispatchNotification: dispatch }));

import { POST } from '@/app/api/notifications/send/route';

const caseId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const recipientUserId = '33333333-3333-4333-8333-333333333333';
let taskExists: boolean;
let taskFilters: Record<string, unknown>;
let rpc: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('APP_BASE_URL', 'http://app.test');
  taskExists = true;
  taskFilters = {};
  rpc = vi.fn().mockResolvedValue({ data: 'notification-id', error: null });
  staff.mockResolvedValue({
    rpc,
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          if (table === 'case_tasks') taskFilters[key] = value;
          return query;
        },
        maybeSingle: async () => ({
          data:
            table === 'case_tasks' ? (taskExists ? { id: taskId } : null) : { full_name: '新郎' },
          error: null,
        }),
      };
      return query;
    },
  });
  const query = {
    select: () => query,
    eq: () => query,
    single: async () => ({ data: { id: 'notification-id' }, error: null }),
  };
  admin.mockReturnValue({ from: () => query });
  dispatch.mockReset().mockResolvedValue({
    notificationId: 'notification-id',
    channel: 'in_app',
    delivered: true,
  });
});
afterEach(() => vi.unstubAllEnvs());

async function send(extra: Record<string, unknown>) {
  return POST(
    new Request('http://app.test/api/notifications/send', {
      method: 'POST',
      headers: { origin: 'http://app.test', 'content-type': 'application/json' },
      body: JSON.stringify({
        caseId,
        recipientUserId,
        channel: 'in_app',
        notificationType: 'info',
        subject: 'ご案内',
        message: 'マイページをご確認ください',
        ...extra,
      }),
    }),
  );
}

describe('通知の宿題リンク作成', () => {
  it('宿題の案件所属を確認して固定の詳細パスを保存する', async () => {
    const response = await send({ taskId, link_path: 'https://evil.test' });
    expect(response.status).toBe(201);
    expect(taskFilters).toEqual({ id: taskId, case_id: caseId });
    expect(rpc.mock.calls[0][1].p_link_path).toBe(`/mypage/tasks/${taskId}`);
    expect(await response.json()).toMatchObject({ delivered: true });
  });
  it('案件に属する宿題が見えなければ保存も送信もしない', async () => {
    taskExists = false;
    expect((await send({ taskId })).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('宿題を指定しない旧要求は一覧へのリンクを保存する', async () => {
    expect((await send({})).status).toBe(201);
    expect(rpc.mock.calls[0][1].p_link_path).toBe('/mypage/tasks');
  });
  it('不正な宿題IDは保存前に拒否する', async () => {
    expect((await send({ taskId: '../other' })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
