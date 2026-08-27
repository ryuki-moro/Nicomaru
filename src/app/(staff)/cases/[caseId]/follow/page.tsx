/**
 * D04 フォロー記録画面（4-1／4-3 D04、要件4-4）。
 *
 * 記録は follow_logs へ登録し、直近の記録を一覧表示する。
 * 一覧の読み取りは 6-5 の原則どおり Server Component から RLS 適用クライアントで直接 select し、
 * 登録だけを /api/cases/{caseId}/follow-logs（表6-6）へ投げる。
 * フォロー記録は D03 準備シートと 6-8 リスク算出（最終アクティビティ）の参考情報になる。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { FollowForm } from '@/app/(staff)/cases/[caseId]/follow/FollowForm';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  COUPLE_PROFILE_COLUMNS,
  FOLLOW_METHOD_LABEL,
  LIST_PAGE_SIZE,
  type FollowMethod,
} from '@/lib/constants';
import { decryptPii } from '@/lib/crypto';
import { fromPostgresError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

interface CaseRow {
  id: string;
  case_code: string;
  wedding_date: string;
}

interface CoupleProfileRow {
  full_name: string | null;
  is_primary_contact: boolean;
}

interface FollowLogRow {
  id: string;
  planner_id: string;
  method: FollowMethod;
  note: string | null;
  followed_at: string;
}

/** 暗号化列（13-1）。平文のまま入っている初期データは復号せずそのまま見せる。 */
function readPii(value: string | null): string {
  if (!value) return '';
  try {
    return decryptPii(value) ?? '';
  } catch {
    return value;
  }
}

const dateTimeFormat = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Tokyo',
});
const dateFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'long', timeZone: 'Asia/Tokyo' });

export default async function FollowLogPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: caseData, error: caseError } = await supabase
    .from('wedding_cases')
    .select('id, case_code, wedding_date')
    .eq('id', caseId)
    .maybeSingle();
  // RLS の範囲外・アーカイブ済みも 0 行になるため 404 として扱う（4-3 エラー表示規約）
  if (caseError) throw fromPostgresError(caseError);
  if (!caseData) notFound();

  const weddingCase = caseData as unknown as CaseRow;

  // couple_profiles は memo を列レベル権限で剥奪しているため COUPLE_PROFILE_COLUMNS を使う（付録A）
  const { data: profiles, error: profileError } = await supabase
    .from('couple_profiles')
    .select(COUPLE_PROFILE_COLUMNS)
    .eq('case_id', caseId);
  if (profileError) throw fromPostgresError(profileError);

  const coupleName = ((profiles ?? []) as unknown as CoupleProfileRow[])
    .slice()
    .sort((a, b) => Number(b.is_primary_contact) - Number(a.is_primary_contact))
    .map((profile) => readPii(profile.full_name))
    .filter((name) => name !== '')
    .join('・');

  const { data: logData, error: logError } = await supabase
    .from('follow_logs')
    .select('id, planner_id, method, note, followed_at')
    .eq('case_id', caseId)
    .order('followed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(LIST_PAGE_SIZE);
  if (logError) throw fromPostgresError(logError);

  const logs = (logData ?? []) as unknown as FollowLogRow[];

  // user_profiles の select ポリシーは「本人または同式場の admin」に限られるため、
  // planner が他プランナーの表示名を引くと 0 行になる。埋め込みではなく別クエリにして
  // 引けなかった分は「担当プランナー」と表示する（一覧全体を落とさないため）。
  const plannerNames = new Map<string, string>();
  const plannerIds = [...new Set(logs.map((log) => log.planner_id))];
  if (plannerIds.length > 0) {
    const { data: planners, error: plannerError } = await supabase
      .from('user_profiles')
      .select('id, display_name')
      .in('id', plannerIds);
    if (plannerError) throw fromPostgresError(plannerError);
    for (const planner of (planners ?? []) as { id: string; display_name: string }[]) {
      plannerNames.set(planner.id, planner.display_name);
    }
  }

  return (
    <div>
      <nav aria-label="パンくず" className="mb-3">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li>
            <Link href="/dashboard" className="text-link hover:underline">
              ダッシュボード
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href="/cases" className="text-link hover:underline">
              案件一覧
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href={`/cases/${caseId}`} className="text-link hover:underline">
              {weddingCase.case_code}
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page">フォロー記録</li>
        </ol>
      </nav>

      <h1 className="section-head">フォロー記録</h1>
      <p className="mt-1 text-caption text-text-muted">
        {weddingCase.case_code}
        {coupleName && ` / ${coupleName} さま`} ・ 挙式日{' '}
        {dateFormat.format(new Date(`${weddingCase.wedding_date}T00:00:00+09:00`))}
      </p>

      <section className="card mt-4">
        <h2 className="text-label font-bold text-text-primary">今回のフォローを記録する</h2>
        <p className="mb-3 mt-1 text-caption text-text-muted">
          電話や打ち合わせでのやり取りを残しておくと、次の担当者にも引き継げます。
        </p>
        <FollowForm caseId={caseId} />
      </section>

      <section className="mt-6">
        <h2 className="section-head">これまでの記録</h2>
        {logs.length === 0 ? (
          <div className="mt-2">
            <EmptyState message="まだフォロー記録はありません。" />
          </div>
        ) : (
          <div className="table-wrap mt-2">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">実施日時</th>
                  <th scope="col">手段</th>
                  <th scope="col">担当</th>
                  <th scope="col">メモ</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className="whitespace-nowrap">
                      {dateTimeFormat.format(new Date(log.followed_at))}
                    </td>
                    <td className="whitespace-nowrap">{FOLLOW_METHOD_LABEL[log.method]}</td>
                    <td className="whitespace-nowrap">
                      {plannerNames.get(log.planner_id) ?? '担当プランナー'}
                    </td>
                    <td className="whitespace-pre-wrap">{log.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
