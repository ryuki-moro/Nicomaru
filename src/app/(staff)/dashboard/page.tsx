/**
 * D01 プランナーダッシュボード（4-1／4-3 D01）。
 *
 * サマリーカードは「担当案件数」「未提出件数」「リスク高件数」の3枚（機能4-1／6-2、Phase 2）。
 * 「今日フォローすべきカップル」は機能4-2。リスクの高い順に並べ、
 * スコアだけでなく**根拠を必ず併記**する（4-3 D01）。
 * 根拠なしの数値だけを出さないのは、1-4「最終判断はプランナーが行う。
 * システムは判断を代替しない」と 8-5 の説明可能性に対応するため。
 *
 * 値は risk_score_snapshots の現在値を読むだけで、ここでは再計算しない
 * （6-8「一覧表示時に毎回全件再計算せず、更新時・定期処理・明示再計算で保存する」）。
 *
 * 読み取りは 6-5 の原則どおり Server Component から RLS 適用クライアントで直接 select する。
 */
import Link from 'next/link';

import { RiskBadge, type RiskReasonView } from '@/components/ui/RiskBadge';
import { requireStaff } from '@/lib/auth/session';
import {
  COUPLE_PROFILE_COLUMNS,
  RISK_LEVEL_RANK,
  UNSUBMITTED_TASK_STATUSES,
  type RiskLevel,
} from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { fromPostgresError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
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

  // ---------------------------------------------------- リスク可視化（機能4-2／6-2）
  // 現在値（is_current）だけを読む。再計算は明示再計算か定期処理が行う（6-8）。
  interface SnapshotRow {
    case_id: string;
    score_value: number;
    score_level: RiskLevel;
    reasons: RiskReasonView[] | null;
  }
  let snapshots: SnapshotRow[] = [];
  if (caseIds.length > 0) {
    const { data, error } = await supabase
      .from('risk_score_snapshots')
      .select('case_id, score_value, score_level, reasons')
      .in('case_id', caseIds)
      .eq('is_current', true);
    if (error) throw fromPostgresError(error);
    snapshots = (data ?? []) as unknown as SnapshotRow[];
  }
  const highRiskCount = snapshots.filter((s) => s.score_level === 'high').length;

  // 案件番号・挙式日とカップル名を後から当てる。
  // couple_profiles は memo を列権限で剥奪しているため、埋め込みではなく列を明示して引く（付録A）。
  const attention = snapshots.filter((s) => s.score_level !== 'low');
  const attentionIds = attention.map((s) => s.case_id);

  const caseMeta = new Map<string, { caseCode: string; weddingDate: string | null }>();
  const nameByCase = new Map<string, string[]>();
  if (attentionIds.length > 0) {
    const [meta, profiles] = await Promise.all([
      supabase.from('wedding_cases').select('id, case_code, wedding_date').in('id', attentionIds),
      supabase.from('couple_profiles').select(COUPLE_PROFILE_COLUMNS).in('case_id', attentionIds),
    ]);
    if (meta.error) throw fromPostgresError(meta.error);
    if (profiles.error) throw fromPostgresError(profiles.error);

    for (const row of (meta.data ?? []) as unknown as
      { id: string; case_code: string; wedding_date: string | null }[]) {
      caseMeta.set(row.id, {
        caseCode: row.case_code,
        weddingDate: row.wedding_date ? row.wedding_date.slice(0, 10) : null,
      });
    }
    for (const p of (profiles.data ?? []) as unknown as
      { case_id: string; full_name: string; is_primary_contact: boolean }[]) {
      const list = nameByCase.get(p.case_id) ?? [];
      // 主連絡先を先頭に（K01 の表示順と揃える）
      if (p.is_primary_contact) list.unshift(readPii(p.full_name));
      else list.push(readPii(p.full_name));
      nameByCase.set(p.case_id, list);
    }
  }

  const followUps = attention
    .map((s) => ({
      caseId: s.case_id,
      caseCode: caseMeta.get(s.case_id)?.caseCode ?? '',
      weddingDate: caseMeta.get(s.case_id)?.weddingDate ?? null,
      coupleName: (nameByCase.get(s.case_id) ?? []).filter(Boolean).join('・'),
      scoreLevel: s.score_level,
      reasons: s.reasons ?? [],
    }))
    // リスクの高い順 → 挙式日が近い順。同着は case_id で決定的にする（4-3 一覧画面共通）。
    .sort((a, b) =>
      RISK_LEVEL_RANK[b.scoreLevel] - RISK_LEVEL_RANK[a.scoreLevel]
      || (a.weddingDate ?? '9999-12-31').localeCompare(b.weddingDate ?? '9999-12-31')
      || a.caseId.localeCompare(b.caseId))
    .slice(0, 10);

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
        <SummaryCard
          label="リスクが高い案件"
          value={highRiskCount}
          unit="件"
          note="直近の算出結果です（6-8）"
        />
      </div>

      <section className="mt-6">
        <h2 className="section-head">今日フォローすべきカップル</h2>
        <p className="mt-1 text-caption text-text-muted">
          リスクの高い順に表示しています。判断の材料としてお使いください。
        </p>
        {followUps.length === 0 ? (
          <p className="card mt-2 text-label text-text-muted">
            いま気にかけたい案件はありません。
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {followUps.map((item) => (
              <li key={item.caseId} className="card">
                <Link href={`/cases/${item.caseId}`} className="block">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-base text-text-primary">
                      {item.coupleName || item.caseCode}
                    </span>
                    <RiskBadge level={item.scoreLevel} reasons={item.reasons} />
                  </div>
                  <p className="mt-1 text-caption text-text-muted">
                    {item.caseCode}
                    {item.weddingDate ? ` ／ 挙式 ${formatDate(item.weddingDate)}` : ''}
                  </p>
                  {/* 4-3 D01「スコア根拠を併記」。根拠のない数値だけは出さない */}
                  <ul className="mt-2 space-y-1">
                    {item.reasons.map((reason) => (
                      <li key={reason.conditionKey} className="text-caption text-text-secondary">
                        ・{reason.description ?? reason.name}
                      </li>
                    ))}
                  </ul>
                </Link>
              </li>
            ))}
          </ul>
        )}
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
