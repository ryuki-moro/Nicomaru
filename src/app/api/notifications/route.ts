/**
 * GET /api/notifications — 通知一覧の取得（表6-6、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 M05／N01／7-3。
 *
 * 範囲は RLS に委ねる（6-5「認証確認は JWT を検証し、その後の権限範囲は RLS に委譲する」）。
 * notifications_select は「受信者本人／自式場の admin／自担当案件の planner／system_admin」を許す。
 */
import { usingD1 } from '@/lib/d1/mode';
import { ok, route } from '@/lib/api/route';
import { requireAppUser } from '@/lib/auth/session';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { fromPostgresError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = route(async (request: Request) => {
  const user = await requireAppUser();

  const url = new URL(request.url);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  if (usingD1()) {
    const { localDB } = await import('@/lib/d1/runtime');
    const { listNotifications } = await import('@/lib/d1/notifications');
    const rows = await listNotifications(await localDB(), user, offset);
    return ok({
      items: rows.slice(0, LIST_PAGE_SIZE),
      offset,
      hasNext: rows.length > LIST_PAGE_SIZE,
    });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('notifications')
    .select(
      'id, case_id, channel, notification_type, title, body, status, sent_at, read_at, created_at',
    )
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + LIST_PAGE_SIZE);
  if (error) throw fromPostgresError(error);

  const rows = data ?? [];
  const hasNext = rows.length > LIST_PAGE_SIZE;

  return ok({ items: rows.slice(0, LIST_PAGE_SIZE), offset, hasNext });
});
