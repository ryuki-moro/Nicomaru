/**
 * S01 式場一覧画面（system_admin、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 S01／機能8-1。
 *
 *   「式場一覧（式場名・管理者名・登録日）。「新規登録」（S02）」
 *
 * 読み取りは 6-5 の原則どおり Server Component から RLS 適用クライアントで直接 select する。
 * venues_select は system_admin に全件、それ以外には自式場だけを見せる（付録A）。
 * この画面は system_admin 専用なので、レイアウトのロール判定に加えてここでも絞る。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/ui/EmptyState';
import { getAppUser } from '@/lib/auth/session';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { formatDate } from '@/lib/format';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface VenueRow {
  id: string;
  name: string;
  code: string;
  contact_email: string | null;
  active: boolean;
  created_at: string;
  /** 埋め込みで式場管理者を引く。複数いる場合があるので配列で受ける */
  user_profiles: { display_name: string; role: string; status: string }[];
}

interface Props {
  searchParams: Promise<{ page?: string }>;
}

export default async function VenueListPage({ searchParams }: Props) {
  const user = await getAppUser();
  // 4-3: S01〜S03 は system_admin 専用（Phase 2）
  if (!user || user.role !== 'system_admin') redirect('/error?code=403');

  const params = await searchParams;
  const page = Math.max(Number(params.page) || 1, 1);
  const offset = (page - 1) * LIST_PAGE_SIZE;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('venues')
    .select('id, name, code, contact_email, active, created_at, user_profiles ( display_name, role, status )')
    .order('code', { ascending: true })
    .range(offset, offset + LIST_PAGE_SIZE);

  const rows = (data ?? []) as unknown as VenueRow[];
  const hasNext = rows.length > LIST_PAGE_SIZE;
  const visible = rows.slice(0, LIST_PAGE_SIZE);

  const linkTo = (next: number) => (next > 1 ? `/venues?page=${next}` : '/venues');

  return (
    <div className="space-y-4">
      <nav aria-label="パンくず">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li aria-current="page">式場一覧</li>
        </ol>
      </nav>

      <div className="flex items-center justify-between gap-3">
        <h1 className="section-head">式場一覧</h1>
        <Link href="/venues/new" className="btn-primary w-auto whitespace-nowrap px-5 text-center">
          新規登録
        </Link>
      </div>

      {error && (
        <div role="alert" className="banner-error">
          <span>式場一覧を取得できませんでした。時間をおいてお試しください。</span>
        </div>
      )}

      {!error && visible.length === 0 && <EmptyState message="登録されている式場はありません。" />}

      {visible.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">式場コード</th>
                <th scope="col">式場名</th>
                <th scope="col">管理者</th>
                <th scope="col">登録日</th>
                <th scope="col">状態</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                // 4-3 S01「管理者名」。削除済みは対象から外す
                const admins = row.user_profiles
                  .filter((u) => u.role === 'admin' && u.status !== 'deleted')
                  .map((u) => u.display_name);
                return (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/venues/${row.id}`} className="text-link hover:underline">
                        {row.code}
                      </Link>
                    </td>
                    <td>{row.name}</td>
                    <td>{admins.length > 0 ? admins.join('・') : '（未登録）'}</td>
                    <td>{formatDate(row.created_at.slice(0, 10))}</td>
                    <td>{row.active ? '利用中' : '停止中'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(page > 1 || hasNext) && (
        <div className="flex items-center justify-between">
          {page > 1 ? (
            <Link href={linkTo(page - 1)} className="btn-ghost">前のページ</Link>
          ) : <span />}
          {hasNext && <Link href={linkTo(page + 1)} className="btn-ghost">次のページ</Link>}
        </div>
      )}
    </div>
  );
}
