/**
 * K01 案件一覧画面（planner／admin）
 *
 * 正本: 基本設計書 Version 1.2 4-3 K01。
 *   - planner は自身の担当のみ、admin は式場内全件（絞り込みは RLS の accessible_case_ids() が担う）
 *   - 表示範囲フィルタ（進行中／アーカイブ済み。アーカイブ済みは admin のみ選択可）
 *   - 並びの既定は挙式日順。リスクが高い順にも切り替えられる（機能6-2、Phase 2）
 *   - 既定50件、同着は id を最終タイブレークに用いる
 *   - アーカイブ済み案件の行には「復元する」（機能2-6、admin のみ）
 *
 * 読み取りは 6-5 の原則どおり Server Component から Supabase 直アクセス（RLS適用）で行い、
 * Route Handler は経由しない。
 */
import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/ui/EmptyState';
import { getAppUser } from '@/lib/auth/session';
import { CASE_STATUS_LABEL, LIST_PAGE_SIZE } from '@/lib/constants';
import { RiskBadge, RiskNotCalculated } from '@/components/ui/RiskBadge';
import { formatDate } from '@/lib/format';
import {
  loadCaseList,
  setCaseArchived,
  SEARCH_SCAN_LIMIT,
  type CaseListItem,
} from '@/lib/services/cases';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * アーカイブ解除（機能2-6）。
 * PATCH /api/cases/{caseId}（archived:false）と同じ RPC を呼ぶ。
 * ボタン1つのためにクライアントコンポーネントを増やさず、Server Action で完結させる（6-5）。
 * 権限（admin のみ）は apply_case_update() 側でも検証される。
 */
async function restoreCase(formData: FormData) {
  'use server';

  const caseId = String(formData.get('caseId') ?? '');
  if (!caseId) return;

  const actor = await getAppUser();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'system_admin')) redirect('/error');

  const supabase = await createSupabaseServerClient();
  try {
    await setCaseArchived(supabase, caseId, false);
  } catch {
    redirect('/cases?scope=archived&error=restore');
  }

  revalidatePath('/cases');
  redirect('/cases');
}

interface Props {
  searchParams: Promise<{ q?: string; scope?: string; page?: string; error?: string; sort?: string }>;
}

export default async function CaseListPage({ searchParams }: Props) {
  const user = await getAppUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const canSeeArchived = user.role === 'admin' || user.role === 'system_admin';
  const scope = params.scope === 'archived' && canSeeArchived ? 'archived' : 'active';
  // 4-3 K01: 並び順の既定は挙式日順。リスクスコア順は機能6-2（Phase 2）で追加する。
  const sort = params.sort === 'risk' ? 'risk' : 'wedding_date';
  const keyword = (params.q ?? '').trim();
  const page = Math.max(Number(params.page) || 1, 1);
  const offset = (page - 1) * LIST_PAGE_SIZE;

  const supabase = await createSupabaseServerClient();

  // 取得・復号・並べ替え・キーワード絞り込みはサービス層に置く。
  // 画面と GET /api/cases に同じ処理が二重にあり、挙動が食い違っていた（#18）。
  let visible: CaseListItem[] = [];
  let hasNext = false;
  let truncated = false;
  let loadError = false;
  try {
    const result = await loadCaseList(supabase, {
      scope, sort, keyword, offset, limit: LIST_PAGE_SIZE,
    });
    visible = result.items;
    hasNext = result.hasNext;
    truncated = result.truncated;
  } catch {
    loadError = true;
  }

  const linkTo = (next: { scope?: string; page?: number; sort?: string }) => {
    const search = new URLSearchParams();
    if (keyword) search.set('q', keyword);
    const nextScope = next.scope ?? scope;
    if (nextScope === 'archived') search.set('scope', 'archived');
    const nextSort = next.sort ?? sort;
    if (nextSort === 'risk') search.set('sort', 'risk');
    const nextPage = next.page ?? page;
    if (nextPage > 1) search.set('page', String(nextPage));
    const qs = search.toString();
    return qs ? `/cases?${qs}` : '/cases';
  };

  return (
    <div className="space-y-4">
      <nav aria-label="パンくず">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li>
            <Link href="/dashboard" className="text-link hover:underline">
              ダッシュボード
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page">案件一覧</li>
        </ol>
      </nav>

      <div className="flex items-center justify-between gap-3">
        <h1 className="section-head">案件一覧</h1>
        {user.role === 'planner' && (
          <Link href="/cases/new" className="btn-primary w-auto whitespace-nowrap px-5 text-center">
            新規案件登録
          </Link>
        )}
      </div>

      {params.error === 'restore' && (
        <div role="alert" className="banner-error">
          <span>復元できませんでした。時間をおいてもう一度お試しください。</span>
        </div>
      )}

      {/* 検索・表示範囲フィルタ。GET フォームなので状態はURLに残り、共有・再読込に耐える */}
      <form method="get" action="/cases" className="card flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label htmlFor="q" className="field-label">
            検索キーワード（案件番号・カップル名）
          </label>
          <input id="q" name="q" defaultValue={keyword} className="field" maxLength={100} />
        </div>

        {canSeeArchived && (
          <div className="min-w-[160px]">
            <label htmlFor="scope" className="field-label">
              表示範囲
            </label>
            <select id="scope" name="scope" defaultValue={scope} className="field">
              <option value="active">進行中</option>
              <option value="archived">アーカイブ済み</option>
            </select>
          </div>
        )}

        <div className="min-w-[160px]">
          <label htmlFor="sort" className="field-label">
            並び順
          </label>
          <select id="sort" name="sort" defaultValue={sort} className="field">
            <option value="wedding_date">挙式日順</option>
            <option value="risk">リスクが高い順</option>
          </select>
        </div>

        <button type="submit" className="btn-secondary w-auto px-6">
          絞り込む
        </button>
      </form>

      {loadError && (
        <div role="alert" className="banner-error">
          <span>案件一覧を取得できませんでした。時間をおいてもう一度お試しください。</span>
        </div>
      )}

      {!loadError && visible.length === 0 && (
        <EmptyState
          message={
            keyword
              ? '条件に合う案件は見つかりませんでした。キーワードを変えてお試しください。'
              : 'まだ案件がありません。「新規案件登録」から登録できます。'
          }
        />
      )}

      {visible.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">案件番号</th>
                <th scope="col">カップル名</th>
                <th scope="col">挙式日</th>
                <th scope="col">プラン種別</th>
                <th scope="col">宿題進捗</th>
                <th scope="col">リスク</th>
                <th scope="col">状態</th>
                {scope === 'archived' && canSeeArchived && <th scope="col">操作</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/cases/${row.id}`} className="text-link hover:underline">
                      {row.caseCode}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/cases/${row.id}`} className="text-link hover:underline">
                      {row.coupleName || '（氏名未登録）'}
                    </Link>
                  </td>
                  <td>{formatDate(row.weddingDate)}</td>
                  <td>{row.planTypeName}</td>
                  <td>
                    {row.total === 0
                      ? '未割当'
                      : `${row.done} / ${row.total} 件（${Math.round((row.done / row.total) * 100)}%）`}
                  </td>
                  <td>
                    {/* 6-8: 現在値を読むだけ。ここでは再計算しない。
                        未算出を空欄にすると「リスクが低い」と読まれるため明示する */}
                    {row.risk
                      ? <RiskBadge level={row.risk.score_level} reasons={row.risk.reasons ?? []} />
                      : <RiskNotCalculated />}
                  </td>
                  <td>{CASE_STATUS_LABEL[row.status]}</td>
                  {scope === 'archived' && canSeeArchived && (
                    <td>
                      <form action={restoreCase}>
                        <input type="hidden" name="caseId" value={row.id} />
                        <button type="submit" className="btn-ghost">
                          復元する
                        </button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(page > 1 || hasNext) && (
        <div className="flex items-center justify-between text-label">
          {page > 1 ? (
            <Link href={linkTo({ page: page - 1 })} className="btn-ghost">
              前の{LIST_PAGE_SIZE}件
            </Link>
          ) : (
            <span />
          )}
          {hasNext ? (
            <Link href={linkTo({ page: page + 1 })} className="btn-ghost">
              次の{LIST_PAGE_SIZE}件
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}

      {keyword && truncated && (
        <p className="text-caption text-text-muted">
          該当が多いため先頭{SEARCH_SCAN_LIMIT}件までを対象に検索しています。
          キーワードを追加すると絞り込めます。
        </p>
      )}
    </div>
  );
}
