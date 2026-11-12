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
import { CaseAiPanels } from './CaseAiPanels';
import { GuestResponseList } from '@/components/guests/GuestResponseList';
import { Breadcrumbs, DASHBOARD_CRUMB } from '@/components/layout/Breadcrumbs';
import { SeatingChartReview } from '@/components/seating/SeatingChartReview';
import { SeatingLayoutEditor } from '@/components/seating/SeatingLayoutEditor';
import type { RiskReasonView } from '@/components/ui/RiskBadge';
import { requirePageUser } from '@/lib/auth/session';
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
import { AUTO_GUEST_TAGS, customTagKey } from '@/lib/guest-tags';
import { seatGuestsFromBook } from '@/lib/seating/guests';
import { needsFrom } from '@/lib/seating/layout';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { InvitationSection } from './InvitationSection';
import { RiskSection, type CaseRisk } from './RiskSection';
import { TaskSection, type CaseTaskRow } from './TaskSection';
export const dynamic = 'force-dynamic';
/** ページ内の目次。id は下の各セクションに付けたものと対応させる。 */
const SECTION_LINKS = [
  { id: 'basic', label: '基本情報' },
  { id: 'risk', label: 'リスク' },
  { id: 'tasks', label: '宿題' },
  { id: 'invitation', label: '招待状況' },
  { id: 'guests', label: 'ゲストの出欠' },
  { id: 'seating', label: '席次' },
] as const;
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
  plan_types: {
    name: string;
  } | null;
  user_profiles: {
    display_name: string;
  } | null;
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
/** 席次（#180〜#182、D1版）。補助表示なので、読めなくても案件詳細は出す（null はエラー表示）。 */
async function loadD1Seating(
  user: {
    id: string;
  },
  caseId: string,
) {
  try {
    const { localDB } = await import('@/lib/d1/runtime');
    const { loadSeatingChart, loadSeatingLayouts } = await import('@/lib/d1/seating');
    const db = await localDB();
    const [layouts, chart] = await Promise.all([
      loadSeatingLayouts(db, user, caseId),
      loadSeatingChart(db, user, caseId),
    ]);
    return { layouts, chart };
  } catch (error) {
    console.error('[case] D1の席次を読み込めませんでした', error);
    return null;
  }
}
/** 補助表示なので、読めなくても案件詳細は出す（null はエラー表示）。 */
async function loadD1GuestBook(
  user: {
    id: string;
  },
  caseId: string,
) {
  try {
    const { localDB } = await import('@/lib/d1/runtime');
    const { loadGuestBook: load } = await import('@/lib/d1/guests');
    return await load(await localDB(), user, caseId);
  } catch (error) {
    console.error('[case] D1のゲスト回答を読み込めませんでした', error);
    return null;
  }
}
export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{
    caseId: string;
  }>;
}) {
  const user = await requirePageUser('planner', 'admin', 'system_admin');
  const { caseId } = await params;
  const d1 = true;
  let row: CaseRow;
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const { caseRow } = await import('@/lib/d1/cases');
    try {
      row = await caseRow(await localDB(), user, caseId);
    } catch (error) {
      if (
        (
          error as {
            code?: string;
          }
        ).code === 'NOT_FOUND'
      )
        redirect('/error?code=404');
      throw error;
    }
  }
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
  // 9-1 の分類（7-2「画面: D02, K02」）。
  // 一覧の補助表示なので、取得に失敗しても案件詳細は出す。
  const classifications = new Map<string, string[]>();
  const tasks: CaseTaskRow[] = [...row.case_tasks]
    // 一覧の既定並び順は ORDER BY due_date, display_order, id（4-3）
    .sort(
      (a, b) =>
        a.due_date.localeCompare(b.due_date) ||
        a.display_order - b.display_order ||
        a.id.localeCompare(b.id),
    )
    .map((task) => ({
      id: task.id,
      title: task.title,
      dueDate: task.due_date,
      status: task.status,
      importance: task.importance,
      submissionFormat: task.submission_format,
      aiLabels: classifications.get(task.id) ?? [],
    }));

  // AI拡張（Issue #118、9-8〜9-10）: サーバー側でルール結果を先に作り、最新ジョブがあれば併せて渡す。
  // 集約は ai-ext ヘルパー（D1）で行い、純関数でフォールバックも作る（投入は画面のボタンから汎用APIへ）。
  let aiExt: {
    aiAvailable: boolean;
    lastSeenAt: string | null;
    handoverFallback: import('@/lib/ai/handover').HandoverSummaryOutput;
    handoverJob: import('@/components/ai/useAiJob').AiJobView | null;
    rescheduleFallback: import('@/lib/ai/reschedule').ReschedulePlanOutput;
    rescheduleShifts: import('@/lib/ai/reschedule').RescheduleShift[];
    rescheduleJob: import('@/components/ai/useAiJob').AiJobView | null;
    templateFallback: import('@/lib/ai/template-draft').TemplateDraftOutput;
    templateJob: import('@/components/ai/useAiJob').AiJobView | null;
  } | null = null;
  if (!row.archived_at) {
    try {
      const { todayInJst } = await import('@/lib/format');
      const today = todayInJst();
      const { aggregateHandover, buildHandoverFallback } = await import('@/lib/ai/handover');
      const { buildReschedulePlan } = await import('@/lib/ai/reschedule');
      const { buildTemplateDraft } = await import('@/lib/ai/template-draft');
      const extTasks = row.case_tasks as unknown as {
        id: string;
        title: string;
        status: string;
        due_date: string;
        due_offset_days: number | null;
      }[];
      const aggregate = aggregateHandover(extTasks, today);
      const reschedule = buildReschedulePlan({
        weddingDate: row.wedding_date,
        today,
        tasks: extTasks,
      });
      const templateFallback = buildTemplateDraft({
        existing: extTasks.map((t) => ({
          name: t.title,
          due_offset_days: t.due_offset_days ?? 0,
        })),
        planName: row.plan_types?.name ?? null,
      });
      let aiAvailable = false;
      let lastSeenAt: string | null = null;
      let handoverJob: import('@/components/ai/useAiJob').AiJobView | null = null;
      let rescheduleJob: import('@/components/ai/useAiJob').AiJobView | null = null;
      let templateJob: import('@/components/ai/useAiJob').AiJobView | null = null;
      if (d1) {
        const { localDB } = await import('@/lib/d1/runtime');
        const db = await localDB();
        const { aiAssistStatus } = await import('@/lib/d1/ai');
        const { latestExtJob } = await import('@/lib/d1/ai-ext');
        const status = await aiAssistStatus(db).catch(() => ({
          available: false,
          lastSeenAt: null,
        }));
        aiAvailable = status.available;
        lastSeenAt = status.lastSeenAt;
        const toView = (
          j: Awaited<ReturnType<typeof latestExtJob>>,
        ): import('@/components/ai/useAiJob').AiJobView | null =>
          j
            ? {
                id: j.id,
                status: j.status,
                output: j.output,
                reviewed_output: j.reviewed_output,
                error_message: j.error_message,
              }
            : null;
        [handoverJob, rescheduleJob, templateJob] = await Promise.all([
          latestExtJob(db, user, row.id, 'handover_summary')
            .then(toView)
            .catch(() => null),
          latestExtJob(db, user, row.id, 'reschedule_plan')
            .then(toView)
            .catch(() => null),
          latestExtJob(db, user, row.id, 'template_draft')
            .then(toView)
            .catch(() => null),
        ]);
      }
      aiExt = {
        aiAvailable,
        lastSeenAt,
        handoverFallback: buildHandoverFallback({
          caseCode: row.case_code,
          weddingDate: row.wedding_date,
          today,
          aggregate,
        }),
        handoverJob,
        rescheduleFallback: reschedule.output,
        rescheduleShifts: reschedule.shifts,
        rescheduleJob,
        templateFallback,
        templateJob,
      };
    } catch (error) {
      console.warn('[case] AI拡張パネルの準備に失敗しました', error);
      aiExt = null;
    }
  }

  const incomplete = tasks.filter((task) => INCOMPLETE_TASK_STATUSES.includes(task.status)).length;
  const done = tasks.length - incomplete;
  const archived = row.archived_at !== null;
  // ゲストの出欠回答とタグ。回答の追加は新郎新婦が配るURLから行い、タグは新郎新婦が付けたものを確認・修正できる。
  const guestBook = await loadD1GuestBook(user, row.id);
  // 席次（#180 配置パターン / #182 承認・差し戻し）。D1版でのみ提供する。
  // 席次のルールに渡す出席人数と「座れる人」の候補は、読み込んだ回答から数える
  const seating = await loadD1Seating(user, row.id);
  const seatingNeeds = needsFrom(
    (guestBook?.responses ?? []).map((r) => ({
      attending: r.attending,
      guestSide: r.guestSide,
      relationship: r.relationship,
      people: r.people.length,
    })),
  );
  const attendingPeople = (guestBook?.responses ?? [])
    .filter((r) => r.attending)
    .reduce((sum, r) => sum + r.people.length, 0);
  const seatingTagOptions = [
    ...AUTO_GUEST_TAGS.filter(
      (tag) => tag.key.startsWith('side:') || tag.key.startsWith('relationship:'),
    ).map(({ key, label }) => ({ key, label })),
    ...(guestBook?.tags ?? []).map((tag) => ({ key: customTagKey(tag.id), label: tag.name })),
  ];
  const seatingInfo = guestBook ? seatGuestsFromBook(guestBook).info : {};
  const seatingLayout = seating?.chart.layoutId
    ? (seating.layouts.find((l) => l.id === seating.chart.layoutId) ?? null)
    : null;
  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[DASHBOARD_CRUMB, { label: '案件一覧', href: '/cases' }, { label: row.case_code }]}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="section-head">
          {partners
            .map((partner) => partner.fullName)
            .filter(Boolean)
            .join('・') || '案件詳細'}
        </h1>
      </div>

      {/*
        この案件で行う操作。打ち合わせの前後にいちばん使う2つ（準備シート・打ち合わせ記録）を
        主操作として大きく出し、そのほかは控えめな枠付きボタンにする。
        アーカイブは取り消しに管理者の操作が要るので、admin 系にだけ、いちばん端に離して置く（4-3 K02／K05）。
        アーカイブ済みの案件はどの画面も開けない（D1 側が archived_at IS NULL で絞る）ので、導線ごと出さない。
      */}
      {!archived && (
        <nav aria-label="この案件の操作" className="flex flex-wrap items-center gap-2">
          {/* 4-3 K02 のボタン「打ち合わせ前準備シート（D03、Phase 2）」 */}
          <Link href={`/cases/${row.id}/sheet`} className="btn-primary w-auto px-5 text-center">
            準備シートを開く
          </Link>
          {/* 4-3 D05 打ち合わせ記録・宿題起票（Phase 3）。
              D04 フォロー記録が「連絡したこと」、こちらが「決まったこと」 */}
          <Link
            href={`/cases/${row.id}/meeting-notes`}
            className="btn-secondary w-auto px-5 text-center"
          >
            打ち合わせ記録
          </Link>
          <Link href={`/cases/${row.id}/follow`} className="btn-ghost">
            フォロー記録
          </Link>
          <Link href={`/cases/${row.id}/edit`} className="btn-ghost">
            編集
          </Link>
          {(user.role === 'admin' || user.role === 'system_admin') && (
            <Link
              href={`/cases/${row.id}/archive`}
              className="btn-ghost border-transparent bg-transparent text-text-muted sm:ml-auto"
            >
              アーカイブ
            </Link>
          )}
        </nav>
      )}

      {archived && (
        <div className="banner-info">
          <span>この案件はアーカイブ済みです。内容の変更はできません。</span>
        </div>
      )}

      {/*
        単カラムで長い画面なので、目的の情報へ飛べるページ内の目次を置く。
        スクロールしても上に残し、いまどの案件のどこを見ているかを見失わないようにする。
        押しやすいよう各項目の高さは44pxを確保し、狭い幅では横に流す（折り返して画面を埋めない）。
      */}
      <nav
        aria-label="このページの目次"
        className="no-print sticky top-0 z-10 -mx-4 border-b border-border-light bg-bg px-4"
      >
        <ul className="flex gap-1 overflow-x-auto">
          {SECTION_LINKS.map((link) => (
            <li key={link.id} className="shrink-0">
              <a
                href={`#${link.id}`}
                className="flex min-h-[44px] items-center px-3 text-label text-text-secondary underline-offset-4 hover:text-text-primary hover:underline"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* 基本情報を先に、リスクはその横（PC）／直後（スマートフォン）に置く。
          「誰のどの案件か」を確かめてからリスクと宿題を読む順にする */}
      <div className="grid gap-5 lg:grid-cols-3">
        <section id="basic" className="card scroll-mt-14 space-y-2 lg:col-span-2">
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
                  {partner.email ? (
                    <span className="text-text-muted">　{partner.email}</span>
                  ) : null}
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

        {/* 4-3 K02: リスクは planner／admin のみ。couple 向けの案件詳細では表示しない（6-3） */}
        <div id="risk" className="scroll-mt-14">
          <RiskSection caseId={row.id} risk={currentRisk} />
        </div>
      </div>

      {/* 宿題は毎日見るので、招待状況より先に置く */}
      <div id="tasks" className="scroll-mt-14">
        <TaskSection
          caseId={row.id}
          tasks={tasks}
          hasPlanType={row.plan_type_id !== null}
          readOnly={archived}
        />
      </div>

      <div id="invitation" className="scroll-mt-14">
        <InvitationSection caseId={row.id} readOnly={archived} />
      </div>

      {aiExt && (
        <CaseAiPanels
          caseId={row.id}
          aiAvailable={aiExt.aiAvailable}
          lastSeenAt={aiExt.lastSeenAt}
          handoverFallback={aiExt.handoverFallback}
          handoverJob={aiExt.handoverJob}
          rescheduleFallback={aiExt.rescheduleFallback}
          rescheduleShifts={aiExt.rescheduleShifts}
          rescheduleJob={aiExt.rescheduleJob}
          templateFallback={aiExt.templateFallback}
          templateJob={aiExt.templateJob}
          canRegisterTemplate={user.role === 'admin'}
        />
      )}

      {guestBook !== undefined && (
        <section id="guests" className="scroll-mt-14 space-y-3">
          <h2 className="section-head">ゲストの出欠</h2>
          {guestBook === null ? (
            <div role="alert" className="banner-error">
              <span>ゲストの回答を読み込めませんでした。</span>
            </div>
          ) : (
            <GuestResponseList caseId={row.id} book={guestBook} editable={!archived} />
          )}
        </section>
      )}

      {seating !== undefined && (
        <section id="seating" className="scroll-mt-14 space-y-3">
          <h2 className="section-head">卓の配置パターン</h2>
          {seating === null ? (
            <div role="alert" className="banner-error">
              <span>卓の配置パターンを読み込めませんでした。</span>
            </div>
          ) : (
            <SeatingLayoutEditor
              caseId={row.id}
              layouts={seating.layouts}
              needs={seatingNeeds}
              attendingPeople={attendingPeople}
              tagOptions={seatingTagOptions}
              editable={!archived}
            />
          )}
        </section>
      )}

      {seating && (
        <section className="space-y-3">
          <h2 className="section-head">席次の確認</h2>
          <SeatingChartReview
            caseId={row.id}
            chart={seating.chart}
            layout={seatingLayout}
            info={seatingInfo}
            editable={!archived}
          />
        </section>
      )}
    </div>
  );
}
