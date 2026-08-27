/**
 * K05 案件削除（アーカイブ）確認（admin）
 *
 * 正本: 基本設計書 Version 1.2 4-3 K05／5-1「削除方針」／機能2-5・2-6。
 *   - 確認メッセージと対象案件名を表示する
 *   - 「アーカイブする」（status='archived'、archived_at 記録 → K01）／「キャンセル」（K02）
 *   - 物理削除は行わない。アーカイブ済み案件は K01 の表示範囲フィルタから admin が復元できる
 *
 * ボタン1つのためにクライアントコンポーネントを増やさず Server Action で完結させる（6-5）。
 * 呼び出す RPC は POST /api/cases/{caseId}/archive と同一であり、権限（admin のみ）は
 * apply_case_update() 側でも検証される。
 */
import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getAppUser } from '@/lib/auth/session';
import { COUPLE_PROFILE_COLUMNS, type PartnerRole } from '@/lib/constants';
import { decryptPii } from '@/lib/crypto';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface CaseRow {
  id: string;
  case_code: string;
  wedding_date: string;
  archived_at: string | null;
  couple_profiles: { partner_role: PartnerRole; full_name: string }[];
}

async function archiveCase(formData: FormData) {
  'use server';

  const caseId = String(formData.get('caseId') ?? '');
  if (!caseId) return;

  const actor = await getAppUser();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'system_admin')) redirect('/error');

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('apply_case_update', {
    p_case_id: caseId,
    p_patch: { archived: true },
    p_profiles: {},
    p_due_changes: [],
    p_waived_task_ids: null,
    p_new_tasks: [],
  });
  if (error) redirect(`/cases/${caseId}/archive?error=1`);

  revalidatePath('/cases');
  redirect('/cases');
}

export default async function CaseArchivePage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getAppUser();
  if (!user) redirect('/login');
  // K05 は admin のみ（4-1 表4-10）
  if (user.role !== 'admin' && user.role !== 'system_admin') redirect('/error');

  const { caseId } = await params;
  const { error: errorFlag } = await searchParams;

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('wedding_cases')
    .select(
      `id, case_code, wedding_date, archived_at,
       couple_profiles ( ${COUPLE_PROFILE_COLUMNS} )`,
    )
    .eq('id', caseId)
    .maybeSingle();

  if (!data) redirect('/error');
  const row = data as unknown as CaseRow;
  if (row.archived_at !== null) redirect('/cases?scope=archived');

  const coupleName =
    row.couple_profiles
      .map((profile) => decryptPii(profile.full_name) ?? '')
      .filter((name) => name.length > 0)
      .join('・') || '（氏名未登録）';

  return (
    <div className="space-y-4">
      <nav aria-label="パンくず">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li>
            <Link href="/cases" className="text-link hover:underline">
              案件一覧
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href={`/cases/${row.id}`} className="text-link hover:underline">
              {row.case_code}
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page">アーカイブ</li>
        </ol>
      </nav>

      <h1 className="section-head">案件をアーカイブします</h1>

      {errorFlag && (
        <div role="alert" className="banner-error">
          <span>アーカイブできませんでした。時間をおいてもう一度お試しください。</span>
        </div>
      )}

      <div className="card space-y-3">
        <dl className="space-y-1 text-label">
          <div>
            <dt className="text-caption text-text-muted">案件番号</dt>
            <dd>{row.case_code}</dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">カップル名</dt>
            <dd>{coupleName}</dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">挙式日</dt>
            <dd>{row.wedding_date.replaceAll('-', '/')}</dd>
          </div>
        </dl>

        <div className="banner-info">
          <span>
            アーカイブしても記録は削除されません。案件一覧の表示範囲を「アーカイブ済み」に切り替えると
            内容を確認でき、必要になれば復元できます。
          </span>
        </div>

        <div className="flex gap-3">
          <form action={archiveCase}>
            <input type="hidden" name="caseId" value={row.id} />
            <button type="submit" className="btn-primary w-auto px-6">
              アーカイブする
            </button>
          </form>
          <Link href={`/cases/${row.id}`} className="btn-secondary w-auto px-6 text-center">
            キャンセル
          </Link>
        </div>
      </div>
    </div>
  );
}
