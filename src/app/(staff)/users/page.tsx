/**
 * U01 利用者一覧画面（admin／system_admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3「U01：検索キーワード。一覧（氏名・メール・種別・状態）。
 * admin は式場内、system_admin は全体」。
 *
 * 6-5 の原則により、一覧は API を経由せず Supabase クライアント（RLS適用）で読む。
 * 範囲（式場内／全体）は user_profiles_select が決めるので、ここでは条件を書かない。
 * 検索フォームは GET で自分自身に戻す素の form にし、クライアント JS を増やさない。
 *
 * 4-3 一覧画面共通：既定の表示件数は50件、以降はページング。
 * 打ち切るだけでは51件目以降の利用者を編集・停止できなくなるため、
 * K01／M02 と同じく1件多く取って前後リンクを出す（?page=）。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getAppUser, landingPathFor } from '@/lib/auth/session';
import { LIST_PAGE_SIZE, type Role, type UserStatus } from '@/lib/constants';
import { createSupabaseServerClient } from '@/lib/supabase/server';

import { UserTable, type UserListRow } from './UserTable';

/** 本画面が管理するのは U02 の自動設定規則で作られる種別のみ。couple は招待経由（6-6-1）。 */
const MANAGED_ROLES: readonly Role[] = ['planner', 'admin'];

interface ProfileRow {
  id: string;
  display_name: string;
  email: string;
  role: Role;
  status: UserStatus;
  venue_id: string | null;
}

/**
 * PostgREST の or() はカンマ・括弧で条件を区切るため、検索語をそのまま埋めると
 * 条件式を差し替えられる。値として意味を持つ記号を落としてから埋め込む。
 */
function sanitizeKeyword(raw: string): string {
  return raw.replace(/[,()"\\*%]/g, ' ').trim().slice(0, 100);
}

/** ?page= を1始まりのページ番号にする。壊れた値は1ページ目へ寄せる（K01／M02 と同じ扱い）。 */
function resolvePage(raw: string | undefined): number {
  const parsed = Number(raw ?? '1');
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** 検索条件を保ったままページを送る。q は利用者が入力した文字列をそのまま持ち回す。 */
function pageHref(q: string | undefined, page: number): string {
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (page > 1) query.set('page', String(page));
  const search = query.toString();
  return search ? `/users?${search}` : '/users';
}

export default async function UserListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { q, page: pageParam } = await searchParams;
  const page = resolvePage(pageParam);

  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin' && user.role !== 'system_admin') redirect(landingPathFor(user.role));

  const keyword = sanitizeKeyword(q ?? '');
  const supabase = await createSupabaseServerClient();

  // 1件多く取り、次ページの有無を件数の追加問い合わせなしで判定する。
  const from = (page - 1) * LIST_PAGE_SIZE;
  let query = supabase
    .from('user_profiles')
    .select('id, display_name, email, role, status, venue_id')
    .in('role', MANAGED_ROLES)
    .order('role')
    .order('display_name')
    .order('id')
    .range(from, from + LIST_PAGE_SIZE);

  if (keyword) {
    query = query.or(`display_name.ilike.*${keyword}*,email.ilike.*${keyword}*`);
  }

  const { data, error } = await query;
  const fetched: ProfileRow[] = data ?? [];
  const hasNext = fetched.length > LIST_PAGE_SIZE;
  const profiles = fetched.slice(0, LIST_PAGE_SIZE);

  // 所属式場名は system_admin のときだけ必要。admin は自式場しか見えないため列を出さない
  const showVenue = user.role === 'system_admin';
  const venueNames = new Map<string, string>();
  if (showVenue && profiles.length > 0) {
    const venueIds = [...new Set(profiles.map((p) => p.venue_id).filter((v): v is string => v != null))];
    if (venueIds.length > 0) {
      const { data: venues } = await supabase.from('venues').select('id, name').in('id', venueIds);
      for (const venue of (venues ?? []) as { id: string; name: string }[]) {
        venueNames.set(venue.id, venue.name);
      }
    }
  }

  const rows: UserListRow[] = profiles.map((profile) => ({
    id: profile.id,
    displayName: profile.display_name,
    email: profile.email,
    role: profile.role,
    status: profile.status,
    venueName: profile.venue_id ? venueNames.get(profile.venue_id) ?? null : null,
  }));

  return (
    <div className="space-y-4">
      <nav aria-label="パンくず">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          {/* system_admin は Phase 1 の着地点が本画面のため、親リンクを出さない（4-2） */}
          {user.role === 'admin' && (
            <li className="flex items-center gap-1">
              <Link href="/dashboard" className="text-link hover:underline">
                ダッシュボード
              </Link>
              <span aria-hidden>/</span>
            </li>
          )}
          <li>
            <span aria-current="page">利用者管理</span>
          </li>
        </ol>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="section-head">利用者管理</h1>
        <Link href="/users/new" className="btn-primary w-auto">
          新規登録
        </Link>
      </div>

      <form method="get" className="card flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <label className="field-label" htmlFor="user-search">
            検索キーワード（氏名・メールアドレス）
          </label>
          <input
            id="user-search"
            name="q"
            className="field"
            defaultValue={q ?? ''}
            placeholder="例）山田"
          />
        </div>
        <button type="submit" className="btn-secondary w-auto">
          検索
        </button>
        {keyword && (
          <Link href="/users" className="btn-ghost">
            条件をクリア
          </Link>
        )}
      </form>

      {error ? (
        <p role="alert" className="banner-error">
          利用者を読み込めませんでした。画面を更新してからもう一度お試しください。
        </p>
      ) : (
        <UserTable rows={rows} showVenue={showVenue} currentUserId={user.id} />
      )}

      {!error && (page > 1 || hasNext) && (
        <nav aria-label="ページ送り" className="flex items-center justify-between">
          {page > 1 ? (
            <Link href={pageHref(q, page - 1)} className="btn-ghost">
              前の{LIST_PAGE_SIZE}件
            </Link>
          ) : (
            <span />
          )}
          {hasNext && (
            <Link href={pageHref(q, page + 1)} className="btn-ghost">
              次の{LIST_PAGE_SIZE}件
            </Link>
          )}
        </nav>
      )}

      <p className="text-caption text-text-muted">
        新郎新婦のアカウントは案件の招待URLから作成されるため、この画面には表示されません。
        1ページの表示は{LIST_PAGE_SIZE}件です。続きは「次の{LIST_PAGE_SIZE}件」から、
        目的の利用者が決まっているときは検索キーワードで絞り込んでください。
      </p>
    </div>
  );
}
