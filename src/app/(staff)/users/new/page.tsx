/**
 * U02 利用者登録画面（admin／system_admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-19／6-3-1／6-3-5 表6-4。
 *   初期パスワードは発行せず、初回パスワード設定リンクを送る。
 *   利用者種別・所属式場は画面で選ばせない（サーバー側で決める）。
 *
 * 本画面が表示するのは「サーバー側で決まる値」の確認だけで、
 * 実際の role／venue_id は /api/admin/users が呼び出し元のロールから決める。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getAppUser, landingPathFor } from '@/lib/auth/session';
import { ROLE_LABEL } from '@/lib/constants';
import { createSupabaseServerClient } from '@/lib/supabase/server';

import { UserForm } from './UserForm';

export default async function UserCreatePage() {
  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin' && user.role !== 'system_admin') redirect(landingPathFor(user.role));

  const supabase = await createSupabaseServerClient();

  // 表4-19 の自動設定規則。ここでの表示はサーバー側の判定と同じ規則で作る
  const createdRole = user.role === 'admin' ? 'planner' : 'admin';

  let fixedVenueName: string | null = null;
  let venueOptions: { id: string; name: string }[] = [];

  if (user.role === 'admin' && user.venueId) {
    const { data } = await supabase
      .from('venues')
      .select('name')
      .eq('id', user.venueId)
      .maybeSingle();
    fixedVenueName = (data as { name: string } | null)?.name ?? '所属式場';
  } else {
    // system_admin は venue_id を持たないため、対象式場を選ぶ必要がある。
    // 本来は S02（式場登録・編集）から遷移する導線だが S01〜S03 は Phase 2 のため、
    // Phase 1 は利用中の式場一覧から選ぶ形で代替する（venues_select は system_admin に全件許可）。
    const { data } = await supabase
      .from('venues')
      .select('id, name')
      .eq('active', true)
      .order('name')
      .order('id');
    venueOptions = (data ?? []) as { id: string; name: string }[];
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
            <span aria-current="page">新規登録</span>
          </li>
        </ol>
      </nav>

      <h1 className="section-head">利用者の新規登録</h1>

      <UserForm
        roleLabel={ROLE_LABEL[createdRole]}
        fixedVenueName={fixedVenueName}
        venueOptions={venueOptions}
      />
    </div>
  );
}
