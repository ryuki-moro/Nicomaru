/**
 * K02 案件詳細画面（planner／admin）
 *
 * 正本: 基本設計書 Version 1.2 4-3 K02。
 *   - 基本情報（案件番号・挙式日・新郎新婦氏名・人数・プラン種別）、宿題進捗
 *   - 招待状況セクション（planner／admin のみ）
 *   - 宿題一覧セクション（planner／admin のみ、機能5-5）
 *   - ボタン：編集（K04、planner／admin）、アーカイブ（K05、admin のみ）
 *
 * リスクスコアは Phase 2 のため表示しない。
 * couple 向けの K02 は (couple) 側の画面として別に用意する（本画面は (staff) レイアウト配下）。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { InvitationSection } from './InvitationSection';
import { RiskSection, type CaseRisk } from './RiskSection';
import type { RiskReasonView } from '@/components/ui/RiskBadge';
import { TaskSection, type CaseTaskRow } from './TaskSection';
import { getAppUser } from '@/lib/auth/session';
import {
  CASE_STATUS_LABEL,
  CONTACT_CHANNEL_LABEL,
  COUPLE_PROFILE_COLUMNS,
  INCOMPLETE_TASK_STATUSES,
  PARTNER_ROLE_LABEL,
  type CaseStatus,
  type ContactChannel,
  type Importance,
  type PartnerRole,
  type RiskLevel,
  type SubmissionFormat,
  type TaskStatus,
} from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { formatDate } from '@/lib/format';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const CASE_SELECT =
  `id, case_code, wedding_date, wedding_time, contact_channel, status, guest_count,
   venue_room, plan_type_id, archived_at,
   plan_types ( name ),
   user_profiles ( display_name ),
   couple_profiles ( ${COUPLE_PROFILE_COLUMNS} ),
   case_tasks ( id, title, due_date, status, importance, display_order, submission_format ),
   risk_score_snapshots ( score_value, score_level, reasons, calculated_at, is_current )`;

interface CaseRow {
  id: string;
  case_code: string;
  wedding_date: string;
  wedding_time: string | null;
  contact_channel: ContactChannel;
  status: CaseStatus;
  guest_count: number | null;
  venue_room: string | null;
  plan_type_id: string | null;
  archived_at: string | null;
  plan_types: { name: string } | null;
  user_profiles: { display_name: string } | null;
  couple_profiles: {
    partner_role: PartnerRole;
    full_name: string;
    email: string | null;
    is_primary_contact: boolean;
  }[];
  case_tasks: {
    id: string;
    title: string;
    due_date: string;
    status: TaskStatus;
    importance: Importance;
    display_order: number;
    submission_format: SubmissionFormat;
  }[];
  /** 現在値は case_id ごと1件だが、埋め込みは配列で返るので is_current で絞る（6-8） */
  risk_score_snapshots: {
    score_value: number;
    score_level: RiskLevel;
    reasons: RiskReasonView[] | null;
    calculated_at: string;
    is_current: boolean;
  }[];
}

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const user = await getAppUser();
  if (!user) redirect('/login');

  const { caseId } = await params;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('wedding_cases')
    .select(CASE_SELECT)
    .eq('id', caseId)
    .maybeSingle();

  // 権限外・不存在はどちらも P04 エラーページへ（4-3 エラー表示規約）。
  // RLS により権限外は 0 行として返るため、ここで区別しない（存在の有無を漏らさない）。
  if (!data) redirect('/error');
  const row = data as unknown as CaseRow;

  // 6-8: 現在値を読むだけ。表示のたびに再計算はしない。
  const snapshot = row.risk_score_snapshots?.find((r) => r.is_current) ?? null;
  const currentRisk: CaseRisk | null = snapshot
    ? {
        scoreValue: snapshot.score_value,
        scoreLevel: snapshot.score_level,
        reasons: snapshot.reasons ?? [],
        calculatedAt: snapshot.calculated_at,
      }
    : null;

  const partners = row.couple_profiles
    .map((profile) => ({
      partnerRole: profile.partner_role,
      // 氏名・メールは暗号化列。表示時に復号する（13-1）。
      // 復号できない値で画面ごと 500 にしないよう readPii を使う（読めない値はそのまま出す）
      fullName: readPii(profile.full_name),
      email: readPii(profile.email),
      isPrimaryContact: profile.is_primary_contact,
    }))
    .sort((a, b) => a.partnerRole.localeCompare(b.partnerRole));

  const tasks: CaseTaskRow[] = [...row.case_tasks]
    // 一覧の既定並び順は ORDER BY due_date, display_order, id（4-3）
    .sort(
      (a, b) =>
        a.due_date.localeCompare(b.due_date)
        || a.display_order - b.display_order
        || a.id.localeCompare(b.id),
    )
    .map((task) => ({
      id: task.id,
      title: task.title,
      dueDate: task.due_date,
      status: task.status,
      importance: task.importance,
      submissionFormat: task.submission_format,
    }));

  const incomplete = tasks.filter((task) => INCOMPLETE_TASK_STATUSES.includes(task.status)).length;
  const done = tasks.length - incomplete;
  const isAdmin = user.role === 'admin' || user.role === 'system_admin';
  const archived = row.archived_at !== null;

  return (
    <div className="space-y-5">
      <nav aria-label="パンくず">
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
          <li aria-current="page">{row.case_code}</li>
        </ol>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="section-head">
          {partners.map((partner) => partner.fullName).filter(Boolean).join('・') || '案件詳細'}
        </h1>
        <div className="flex flex-wrap gap-2">
          {!archived && (
            <Link href={`/cases/${row.id}/edit`} className="btn-secondary w-auto px-5 text-center">
              編集
            </Link>
          )}
          {/* 4-3 K02 のボタン「打ち合わせ前準備シート（D03、Phase 2）」 */}
          {!archived && (
            <Link href={`/cases/${row.id}/sheet`} className="btn-secondary w-auto px-5 text-center">
              打ち合わせ前準備シート
            </Link>
          )}
          {!archived && (
            <Link href={`/cases/${row.id}/follow`} className="btn-secondary w-auto px-5 text-center">
              フォロー記録
            </Link>
          )}
          {isAdmin && !archived && (
            <Link href={`/cases/${row.id}/archive`} className="btn-secondary w-auto px-5 text-center">
              アーカイブ
            </Link>
          )}
        </div>
      </div>

      {archived && (
        <div className="banner-info">
          <span>この案件はアーカイブ済みです。内容の変更はできません。</span>
        </div>
      )}

      {/* 4-3 K02: リスクは planner／admin のみ。couple 向けの案件詳細では表示しない（6-3） */}
      <RiskSection caseId={row.id} risk={currentRisk} />

      <section className="card space-y-2">
        <h2 className="section-head">基本情報</h2>
        <dl className="grid grid-cols-1 gap-2 text-label sm:grid-cols-2">
          <div>
            <dt className="text-caption text-text-muted">案件番号</dt>
            <dd>{row.case_code}</dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">状態</dt>
            <dd>{CASE_STATUS_LABEL[row.status]}</dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">挙式日</dt>
            <dd>
              {formatDate(row.wedding_date)}
              {row.wedding_time ? ` ${row.wedding_time.slice(0, 5)}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">プラン種別</dt>
            <dd>{row.plan_types?.name ?? '未設定'}</dd>
          </div>
          {partners.map((partner) => (
            <div key={partner.partnerRole}>
              <dt className="text-caption text-text-muted">
                {PARTNER_ROLE_LABEL[partner.partnerRole]}
                {partner.isPrimaryContact ? '（主連絡先）' : ''}
              </dt>
              <dd>
                {partner.fullName || '（未登録）'}
                {partner.email ? <span className="text-text-muted">　{partner.email}</span> : null}
              </dd>
            </div>
          ))}
          <div>
            <dt className="text-caption text-text-muted">人数</dt>
            <dd>{row.guest_count ?? 0}名</dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">連絡起点</dt>
            <dd>{CONTACT_CHANNEL_LABEL[row.contact_channel]}</dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">担当プランナー</dt>
            <dd>{row.user_profiles?.display_name ?? '未設定'}</dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">宿題進捗</dt>
            <dd>
              {tasks.length === 0
                ? '未割当'
                : `${done} / ${tasks.length} 件（${Math.round((done / tasks.length) * 100)}%）`}
            </dd>
          </div>
        </dl>
      </section>

      <InvitationSection caseId={row.id} readOnly={archived} />

      <TaskSection
        caseId={row.id}
        tasks={tasks}
        hasPlanType={row.plan_type_id !== null}
        readOnly={archived}
      />
    </div>
  );
}
