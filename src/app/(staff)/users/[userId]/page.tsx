/**
 * U03 利用者変更画面（U04 削除確認を含む・admin／system_admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-20／U04 の記述。
 *
 * 読み取りは Supabase クライアント（RLS適用）で行い、更新・削除だけを
 * /api/admin/users/{userId} へ送る（Auth Admin API が必要なため。6-3-5 表6-4）。
 * ここでの管理範囲チェックは導線を正すためのもので、実際の防御は API 層と RLS が担う。
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getAppUser, landingPathFor } from '@/lib/auth/session';
import { ROLE_LABEL, type Role, type UserStatus } from '@/lib/constants';
import { createSupabaseServerClient } from '@/lib/supabase/server';

import { UserEditForm, type SuccessorOption } from './UserEditForm';

interface ProfileRow {
  id: string;
  display_name: string;
  email: string;
  phone: string | null;
  role: Role;
  status: UserStatus;
  venue_id: string | null;
}

export default async function UserEditPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;

  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin' && user.role !== 'system_admin') redirect(landingPathFor(user.role));

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, display_name, email, phone, role, status, venue_id')
    .eq('id', userId)
    .maybeSingle();

  // RLS で 0 行になる場合（別式場など）も「見つからない」として扱い、存在を漏らさない
  if (error || !data) notFound();
  const target = data as ProfileRow;

  const manageable = user.role === 'admin'
    ? target.role === 'planner' && target.venue_id === user.venueId
    : target.role === 'planner' || target.role === 'admin';
  if (!manageable) notFound();

  // 削除済みは変更対象にしない（5-1 削除方針の論理削除）
  const isDeleted = target.status === 'deleted';

  const { data: venue } = target.venue_id
    ? await supabase.from('venues').select('name').eq('id', target.venue_id).maybeSingle()
    : { data: null };

  // U04: 担当案件がある planner は引き継ぎ先の指定が必須になる
  let assignedCaseCount = 0;
  let successorOptions: SuccessorOption[] = [];

  if (target.role === 'planner') {
    const { count } = await supabase
      .from('wedding_cases')
      .select('id', { count: 'exact', head: true })
      .eq('primary_planner_id', target.id);
    assignedCaseCount = count ?? 0;

    if (assignedCaseCount > 0 && target.venue_id) {
      const { data: candidates } = await supabase
        .from('user_profiles')
        .select('id, display_name')
        .eq('role', 'planner')
        .eq('status', 'active')
        .eq('venue_id', target.venue_id)
        .neq('id', target.id)
        .order('display_name')
        .order('id');
      successorOptions = ((candidates ?? []) as { id: string; display_name: string }[])
        .map((row) => ({ id: row.id, displayName: row.display_name }));
    }
  }

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
            <Link href="/users" className="text-link hover:underline">
              利用者管理
            </Link>
          </li>
          <li className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <span aria-current="page">{target.display_name}</span>
          </li>
        </ol>
      </nav>

      <h1 className="section-head">利用者の変更：{target.display_name}</h1>

      {isDeleted ? (
        <div className="card space-y-3">
          <p className="banner-info">
            この利用者は削除済みです。記録は残りますが、変更やログインはできません。
          </p>
          <Link href="/users" className="btn-secondary block text-center">
            一覧に戻る
          </Link>
        </div>
      ) : (
        <UserEditForm
          userId={target.id}
          roleLabel={ROLE_LABEL[target.role]}
          venueName={(venue as { name: string } | null)?.name ?? '未設定'}
          initial={{
            displayName: target.display_name,
            email: target.email,
            phone: target.phone ?? '',
            // deleted は上で分岐済みのため、ここに来る値は表4-20 の3種類だけ
            status: target.status as 'active' | 'invited' | 'suspended',
          }}
          isSelf={target.id === user.id}
          assignedCaseCount={assignedCaseCount}
          successorOptions={successorOptions}
        />
      )}
    </div>
  );
}
