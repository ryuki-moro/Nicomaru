/**
 * D01 プランナーダッシュボード（4-1／4-3 D01）。
 *
 * サマリーカードは「担当案件数」「未提出件数」の2枚のみ。
 * リスク高件数と「今日フォローすべきカップル」は Phase 2 のため、ここでは数えない
 * （4-3 D01。Phase 1 で先取り実装すると risk_score_snapshots が空のまま
 *  常時0件を表示することになり、かえって誤解を招く）。
 *
 * 読み取りは 6-5 の原則どおり Server Component から RLS 適用クライアントで直接 select する。
 */
import Link from 'next/link';

import { requireStaff } from '@/lib/auth/session';
import { UNSUBMITTED_TASK_STATUSES } from '@/lib/constants';
import { fromPostgresError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

interface CaseIdRow {
  id: string;
}

export default async function PlannerDashboardPage() {
  const user = await requireStaff();
  const supabase = await createSupabaseServerClient();

  // アーカイブ済みは件数から除く（K01 の既定表示範囲＝進行中に合わせる）。
  // planner は RLS でも自担当に絞られるが、admin は式場内全件が見えるため
  // 「担当案件数」の意味を保つよう planner のときだけ明示的に担当条件を足す。
  const baseCaseQuery = supabase.from('wedding_cases').select('id').neq('status', 'archived');
  const { data: caseData, error: caseError } = await (
    user.role === 'planner' ? baseCaseQuery.eq('primary_planner_id', user.id) : baseCaseQuery
  );
  if (caseError) throw fromPostgresError(caseError);

  const caseIds = ((caseData ?? []) as CaseIdRow[]).map((row) => row.id);

  // 6-8 と同じ「未提出」の定義（not_started／needs_fix）を UNSUBMITTED_TASK_STATUSES から取る。
  let unsubmittedCount = 0;
  if (caseIds.length > 0) {
    const { count, error } = await supabase
      .from('case_tasks')
      .select('id', { count: 'exact', head: true })
      .in('case_id', caseIds)
      .in('status', [...UNSUBMITTED_TASK_STATUSES]);
    if (error) throw fromPostgresError(error);
    unsubmittedCount = count ?? 0;
  }

  const caseCountLabel = user.role === 'planner' ? '担当案件数' : '式場の案件数';

  return (
    <div>
      <h1 className="section-head">ダッシュボード</h1>
      <p className="mt-1 text-caption text-text-muted">
        {user.displayName} さんの担当状況です。
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SummaryCard label={caseCountLabel} value={caseIds.length} unit="件" />
        <SummaryCard
          label="未提出の宿題"
          value={unsubmittedCount}
          unit="件"
          note="未着手・不備ありの合計です"
        />
      </div>

      <section className="mt-6">
        <h2 className="section-head">今日フォローすべきカップル</h2>
        {/* 4-3 D01: リスクスコア順の抽出は Phase 2。実装せずに予定だけ控えめに示す */}
        <p className="card mt-2 text-label text-text-muted">
          リスクの高い案件の自動抽出は Phase 2 で追加します。それまでは案件一覧から進捗をご確認ください。
        </p>
      </section>

      <section className="mt-6">
        <h2 className="section-head">よく使う画面</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <NavCard
            href="/cases"
            title="案件一覧"
            description="担当している案件の進捗を確認します（K01）"
          />
          <NavCard
            href="/submissions"
            title="提出物確認"
            description="新郎新婦から届いた提出物を確認します（D02）"
          />
        </div>
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: number;
  unit: string;
  note?: string;
}) {
  return (
    <div className="card">
      <p className="text-caption text-text-muted">{label}</p>
      <p className="mt-1">
        <span className="text-hero font-bold text-text-primary">{value}</span>
        <span className="ml-1 text-label text-text-secondary">{unit}</span>
      </p>
      {note && <p className="mt-1 text-caption text-text-muted">{note}</p>}
    </div>
  );
}

function NavCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link href={href} className="card block transition-colors hover:bg-field-filled-bg">
      <p className="text-section font-bold text-text-primary">{title}</p>
      <p className="mt-1 text-caption text-text-muted">{description}</p>
    </Link>
  );
}
