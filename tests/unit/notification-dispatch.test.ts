import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail, sendLine } from '@/lib/notify/send';
import { dispatchNotification, notificationUrl } from '@/lib/services/notifications';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('notificationUrl', () => {
  it('APP_BASE_URLのoriginから絶対URLを作る', () => {
    vi.stubEnv('APP_BASE_URL', 'https://example.test/base');
    expect(notificationUrl('/mypage/tasks/task_1')).toBe(
      'https://example.test/mypage/tasks/task_1',
    );
    expect(notificationUrl(null)).toBeNull();
  });
  it.each([
    '/dashboard',
    '//evil.test',
    '/mypage/../x',
    '/mypageX',
    '/mypage?token=x',
    '/mypage/' + 'a'.repeat(512),
  ])('不正なパスを送信しない: %s', (path) => {
    vi.stubEnv('APP_BASE_URL', 'https://example.test');
    expect(notificationUrl(path)).toBeNull();
  });
  it('基点未設定時はlocalhostへフォールバックしない', () => {
    vi.stubEnv('APP_BASE_URL', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(notificationUrl('/mypage')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
  it.each(['invalid', 'javascript:alert(1)', 'https://user:pass@example.test'])(
    '不正な基点を拒否: %s',
    (base) => {
      vi.stubEnv('APP_BASE_URL', base);
      expect(notificationUrl('/mypage')).toBeNull();
    },
  );
});

vi.mock('@/lib/notify/send', () => ({
  sendEmail: vi.fn(async () => ({ delivered: true })),
  sendLine: vi.fn(async () => ({ delivered: true })),
}));
function client() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn(async () => ({ error: null })),
    maybeSingle: vi.fn(async () => ({
      data: { id: 'u', email: 'couple@example.test', line_user_id: 'line-id', status: 'active' },
      error: null,
    })),
  };
  return {
    from: vi.fn(() => chain),
    rpc: vi.fn(async () => ({ data: true, error: null })),
  } as unknown as SupabaseClient;
}
describe('dispatchNotificationの送信本文', () => {
  it.each(['email', 'line'] as const)('%s: 本文の後に完全なURLを付ける', async (channel) => {
    vi.stubEnv('APP_BASE_URL', 'https://example.test');
    vi.mocked(sendEmail).mockClear();
    vi.mocked(sendLine).mockClear();
    await dispatchNotification(client(), {
      id: 'n',
      venue_id: 'v',
      case_id: 'c',
      recipient_user_id: 'u',
      channel,
      notification_type: 'overdue',
      title: '件名',
      body: 'あ'.repeat(200),
      status: 'queued',
      link_path: '/mypage/tasks/task_1',
    });
    const body =
      channel === 'email'
        ? vi.mocked(sendEmail).mock.calls[0][2]
        : vi.mocked(sendLine).mock.calls[0][1];
    expect(body).toMatch(/マイページで確認する: https:\/\/example.test\/mypage\/tasks\/task_1$/);
    expect(body.split('\n')[0].length).toBe(channel === 'line' ? 80 : 200);
  });
  it('旧通知のNULLリンクでは本文にURLを足さない', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://example.test');
    vi.mocked(sendEmail).mockClear();
    await dispatchNotification(client(), {
      id: 'n',
      venue_id: 'v',
      case_id: 'c',
      recipient_user_id: 'u',
      channel: 'email',
      notification_type: 'overdue',
      title: '件名',
      body: '本文',
      status: 'queued',
      link_path: null,
    });
    expect(sendEmail).toHaveBeenCalledWith('couple@example.test', '件名', '本文');
  });
});
