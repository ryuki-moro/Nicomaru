import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendEmail, sendLine } from '@/lib/notify/send';
import { dispatchNotification, dispatchPendingNotifications } from '@/lib/services/notifications';
import type { SupabaseClient } from '@supabase/supabase-js';

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 'test');
  vi.stubEnv('RESEND_FROM', 'changed@example.test');
  vi.stubEnv('LINE_CHANNEL_ACCESS_TOKEN', 'test');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('送信候補のページ走査', () => {
  it('500件を超える候補をUUIDカーソルで最後まで処理する', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${String(i).padStart(4, '0')}`);
    const filters = vi.fn();
    const order = vi.fn();
    const timestamp = '2026-10-22T00:00:00.000Z';
    let page = 0;
    const from = vi.fn(() => {
      const query = {
        select: () => query,
        in: () => query,
        lte: () => query,
        or: (filter: string) => {
          filters(filter);
          return query;
        },
        order: (column: string) => {
          order(column);
          return query;
        },
        limit: () => query,
        then: (resolve: (value: unknown) => void) =>
          resolve({
            data: ids
              .slice(page++ * 500, page * 500)
              .map((notification_id) => ({ notification_id, next_attempt_at: timestamp })),
            error: null,
          }),
      };
      return query;
    });
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'claim_notification_delivery'
        ? {
            data: [
              {
                notification_id: args.p_id,
                claim_token: 'token',
                retry_key: 'key',
                channel: 'in_app',
                payload: {},
              },
            ],
            error: null,
          }
        : { data: true, error: null },
    );
    expect(
      await dispatchPendingNotifications({ from, rpc } as unknown as SupabaseClient, 60_000),
    ).toMatchObject({ sent: 501, failed: 0, deferred: false });
    expect(filters.mock.calls[1][0]).toContain(`next_attempt_at.gt.${timestamp}`);
    expect(filters.mock.calls[1][0]).toContain(`notification_id.gt.${ids[499]}`);
    expect(order.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([
      'next_attempt_at',
      'notification_id',
    ]);
    expect(from).toHaveBeenCalledTimes(2);
  });
  it('候補取得が失敗したら空扱いで成功にしない', async () => {
    const query = {
      select: () => query,
      in: () => query,
      lte: () => query,
      or: () => query,
      order: () => query,
      limit: () => query,
      then: (resolve: (value: unknown) => void) =>
        resolve({ data: null, error: { code: 'XX000', message: 'failed' } }),
    };
    await expect(
      dispatchPendingNotifications({ from: () => query } as unknown as SupabaseClient),
    ).rejects.toThrow();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('通知providerの冪等性', () => {
  it('Resendへ固定したfrom・キーを渡し、タイムアウトは結果不明にする', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('timeout'));
    vi.stubGlobal('fetch', fetch);
    const r = await sendEmail('to@example.test', '件名', '本文', {
      idempotencyKey: 'key',
      from: 'original@example.test',
    });
    expect(r.outcome).toBe('unknown');
    const request = fetch.mock.calls[0][1];
    expect(request.headers['Idempotency-Key']).toBe('key');
    expect(JSON.parse(request.body).from).toBe('original@example.test');
    expect(request.signal).toBeDefined();
  });
  it('LINEの409は受付IDがある場合だけ受付済みにする', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', { status: 409, headers: { 'x-line-accepted-request-id': 'accepted' } }),
      )
      .mockResolvedValueOnce(new Response('', { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    expect((await sendLine('U123', '本文', { idempotencyKey: 'key' })).delivered).toBe(true);
    expect((await sendLine('U123', '本文', { idempotencyKey: 'key' })).outcome).toBe('rejected');
    expect(fetch.mock.calls[0][1].headers['X-Line-Retry-Key']).toBe('key');
  });
  it('providerの5xxは結果不明、明確な4xxは自動再試行しない', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(new Response('', { status: 400 })),
    );
    expect(
      (await sendEmail('to@example.test', '件名', '本文', { idempotencyKey: 'key' })).outcome,
    ).toBe('unknown');
    expect(
      (await sendEmail('to@example.test', '件名', '本文', { idempotencyKey: 'key' })).outcome,
    ).toBe('rejected');
  });
  it('送信後のDB保存エラーを成功にしない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"id":"accepted"}', { status: 200 })),
    );
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            notification_id: 'id',
            claim_token: 'token',
            retry_key: 'key',
            channel: 'email',
            attempt_count: 1,
            payload: {
              to: 'to@example.test',
              subject: '件名',
              text: '本文',
              from: 'from@example.test',
            },
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'save failed' } });
    await expect(
      dispatchNotification({ rpc } as unknown as SupabaseClient, { id: 'id' }),
    ).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('送信権が取れなければ外部送信しない', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await dispatchNotification(
      {
        rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { state: 'processing', channel: 'email' },
                error: null,
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient,
      { id: 'id' },
    );
    expect(result.delivered).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
