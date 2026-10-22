import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  completed: false,
  blocked: false,
  failSecond: false,
  keys: new Set<string>(),
  upserts: [] as Record<string, unknown>[],
}));
const dispatch = vi.hoisted(() =>
  vi.fn(async () => ({ sent: 0, failed: 0, skipped: 0, deferred: false })),
);
vi.mock('@/lib/api/route', () => ({ route: (fn: unknown) => fn, ok: (value: unknown) => value }));
vi.mock('@/lib/crypto', () => ({ readPii: (value: string) => value }));
vi.mock('@/lib/services/notifications', () => ({ dispatchPendingNotifications: dispatch }));
vi.mock('@/lib/api/internal', () => ({
  runBatch: async (_admin: unknown, _type: unknown, fn: () => Promise<unknown>) => fn(),
  forEachActiveCase: async (
    _admin: unknown,
    fn: (caseId: string, venueId: string) => Promise<void>,
  ) => {
    await fn('case', 'venue');
    return 1;
  },
  BatchFailure: class extends Error {},
}));
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => {
      let insert: Record<string, unknown> | undefined;
      const query = {
        select: () => query,
        or: () => query,
        eq: () => query,
        not: () => query,
        in: () => query,
        order: () => query,
        limit: () => query,
        gt: () => query,
        upsert: (data: Record<string, unknown>) => {
          insert = data;
          return query;
        },
        maybeSingle: async () =>
          table === 'notification_generation_runs'
            ? {
                data: {
                  completed_at: state.completed ? 'done' : null,
                  blocked_reason: state.blocked ? 'legacy_day_needs_review' : null,
                },
                error: null,
              }
            : { data: { user_profiles: { display_name: '担当' } }, error: null },
        then: (resolve: (value: unknown) => void) => {
          if (table === 'notification_generation_runs') {
            state.completed = true;
            return resolve({ error: null });
          }
          if (table === 'notification_settings')
            return resolve({
              data: [{ venue_id: null, due_reminder_days_before: 7 }],
              error: null,
            });
          if (table === 'couple_profiles')
            return resolve({
              data: [{ user_profile_id: 'couple', full_name: '名前' }],
              error: null,
            });
          if (table === 'case_tasks')
            return resolve({
              data: [
                { id: 'task1', title: '宿題1', due_date: '2026-10-21' },
                { id: 'task2', title: '宿題2', due_date: '2026-10-21' },
              ],
              error: null,
            });
          if (table === 'notification_deliveries') return resolve({ count: 0, error: null });
          if (table === 'notifications' && insert) {
            state.upserts.push(insert);
            if (insert.task_id === 'task2' && state.failSecond)
              return resolve({
                data: null,
                error: { code: 'XX000', message: 'temporary failure' },
              });
            const key = [
              insert.task_id,
              insert.recipient_user_id,
              insert.notification_type,
              insert.event_on,
            ].join(':');
            const exists = state.keys.has(key);
            state.keys.add(key);
            return resolve({ data: exists ? [] : [{ id: key }], error: null });
          }
          throw new Error(`unexpected table ${table}`);
        },
      };
      return query;
    },
  }),
}));
import { POST } from '@/app/api/internal/notifications-dispatch/route';

beforeEach(() => {
  state.completed = false;
  state.blocked = false;
  state.failSecond = false;
  state.keys.clear();
  state.upserts = [];
  dispatch.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());
describe('日次生成の再開', () => {
  it('途中失敗後も送信処理を進め、10分cronで不足分を再生成する', async () => {
    const request = new Request(
      'https://example.test/api/internal/notifications-dispatch?dispatchOnly=1',
    );
    state.failSecond = true;
    await expect(POST(request)).rejects.toThrow();
    expect(state.completed).toBe(false);
    expect(state.keys.size).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    state.failSecond = false;
    await POST(request);
    expect(state.completed).toBe(true);
    expect(state.keys.size).toBe(2);
    expect(state.upserts.every((row) => row.event_on === '2026-10-22')).toBe(true);
    const count = state.upserts.length;
    await POST(request);
    expect(state.upserts).toHaveLength(count);
  });
  it('切替日の旧通知があれば自動再生成を止め、要確認として失敗記録へ渡す', async () => {
    state.blocked = true;
    await expect(
      POST(new Request('https://example.test/api/internal/notifications-dispatch')),
    ).rejects.toThrow();
    expect(state.upserts).toHaveLength(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
