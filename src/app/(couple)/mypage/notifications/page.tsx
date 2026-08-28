/**
 * M05 通知一覧画面（couple、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 M05／機能3-5・7-2・7-3。
 *
 *   「通知リスト（日時・チャネル・種別・本文）。通知タップで関連画面（M02／M03等）」
 *
 * 既読化はここで行う（notifications_update_recipient は受信者本人にだけ update を許す。付録A）。
 * 一覧を開いた時点で既読にするのは、7-2 のマイページ内通知が「開いて読むもの」であり、
 * 個別に既読ボタンを押させる導線が 4-3 に無いため。
 */
import Link from 'next/link';

import { EmptyState } from '@/components/ui/EmptyState';
import { getAppUser } from '@/lib/auth/session';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { formatDateTime } from '@/lib/format';
import { NOTIFICATION_TYPE_LABEL, type NotificationType } from '@/lib/notify/templates';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface NotificationRow {
  id: string;
  case_id: string | null;
  notification_type: NotificationType;
  title: string;
  body: string;
  status: string;
  sent_at: string | null;
  read_at: string | null;
  created_at: string;
}

interface Props {
  searchParams: Promise<{ page?: string }>;
}

export default async function NotificationsPage({ searchParams }: Props) {
  const user = await getAppUser();
  const params = await searchParams;
  const page = Math.max(Number(params.page) || 1, 1);
  const offset = (page - 1) * LIST_PAGE_SIZE;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('notifications')
    .select('id, case_id, notification_type, title, body, status, sent_at, read_at, created_at')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + LIST_PAGE_SIZE);

  const rows = (data ?? []) as unknown as NotificationRow[];
  const hasNext = rows.length > LIST_PAGE_SIZE;
  const visible = rows.slice(0, LIST_PAGE_SIZE);

  // 未読を既読にする。失敗しても一覧の表示は妨げない（既読は補助的な状態）。
  const unread = visible.filter((n) => n.read_at === null).map((n) => n.id);
  if (user && unread.length > 0) {
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString(), status: 'read' })
      .in('id', unread);
  }

  return (
    <div className="space-y-4">
      <h1 className="section-head">お知らせ</h1>

      {error && (
        <div role="alert" className="banner-error">
          <span>お知らせを取得できませんでした。時間をおいてお試しください。</span>
        </div>
      )}

      {!error && visible.length === 0 && (
        <EmptyState message="いまお知らせはありません。" />
      )}

      <ul className="space-y-3">
        {visible.map((item) => {
          // 4-3 M05「通知タップで関連画面（M02／M03等）」。
          // 宿題単位のIDは通知に持たせていないため、宿題一覧へ寄せる。
          const href = item.case_id ? '/mypage/tasks' : '/mypage';
          return (
            <li key={item.id}>
              <Link href={href} className="card block">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-base text-text-primary">{item.title}</span>
                  {item.read_at === null && (
                    <span className="mt-1 inline-block size-2 shrink-0 rounded-full bg-danger" aria-label="未読" />
                  )}
                </div>
                <p className="mt-1 text-label text-text-secondary">{item.body}</p>
                <p className="mt-2 text-caption text-text-muted">
                  {NOTIFICATION_TYPE_LABEL[item.notification_type]}
                  {' ／ '}
                  {formatDateTime(item.sent_at ?? item.created_at)}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>

      {(page > 1 || hasNext) && (
        <div className="flex items-center justify-between">
          {page > 1 ? (
            <Link href={`/mypage/notifications?page=${page - 1}`} className="btn-ghost">
              前のページ
            </Link>
          ) : <span />}
          {hasNext && (
            <Link href={`/mypage/notifications?page=${page + 1}`} className="btn-ghost">
              次のページ
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
