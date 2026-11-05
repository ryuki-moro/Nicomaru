import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const { server } = vi.hoisted(() => ({ server: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ getAppUser: async () => null }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: server }));

import NotificationsPage from '@/app/(couple)/mypage/notifications/page';

it('M05は宿題詳細へリンクし、旧NULL行は案件の有無で一覧・マイページに戻す', async () => {
  const rows = [
    { id: '1', case_id: 'case', link_path: '/mypage/tasks/task-id' },
    { id: '2', case_id: 'case', link_path: null },
    { id: '3', case_id: null, link_path: null },
  ].map((row) => ({
    ...row,
    notification_type: 'info',
    title: `通知${row.id}`,
    body: '本文',
    status: 'read',
    read_at: '2026-10-23T00:00:00Z',
    sent_at: null,
    created_at: '2026-10-23T00:00:00Z',
  }));
  const query = {
    select: () => query,
    order: () => query,
    range: async () => ({ data: rows, error: null }),
  };
  server.mockResolvedValue({ from: () => query });
  const html = renderToStaticMarkup(await NotificationsPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('href="/mypage/tasks/task-id"');
  expect(html).toContain('href="/mypage/tasks"');
  expect(html).toContain('href="/mypage"');
});
