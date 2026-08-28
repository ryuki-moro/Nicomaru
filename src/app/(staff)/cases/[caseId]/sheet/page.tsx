/**
 * D03 打ち合わせ前準備シート（planner、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 D03／機能4-5／6-11／表5-21。
 *
 *   「提出済／未提出サマリー、直近の連絡履歴タイムライン、フォロー記録。
 *     AI補助（9-2 要点下書き）を利用可。「印刷する」「PDF出力」。
 *     生成したPDFは storage_files.visibility='planner_only' を既定とし、
 *     couple からは参照できない（6-11）」
 *
 * 【出力手段】
 * 6-11 は「第一手段をブラウザ印刷（印刷用CSS）とし、PDFファイルが必要な場合は
 * @react-pdf/renderer 等の軽量ライブラリでサーバー側生成」と定める。
 * ここでは第一手段の印刷を実装する。ブラウザの「PDFとして保存」でファイル化もできるため、
 * Vercel Hobby のバンドルサイズ・実行時間の制約（2-2-1）を増やさずに要件を満たせる。
 * サーバー側生成は、印刷では足りないと分かってから足す。
 *
 * AI補助（9-2 要点下書き）は、依頼をサーバーアクションで投入し、
 * 生成の監視と採用・破棄を SheetDraftPanel（クライアント）が担う。
 * LLM へ渡す内容はサーバー側で組み立てる（7-4 の入力最小化）。
 * 採用されたものだけが印刷対象のシート本体へ載る（7-1 の確認前提）。
 *
 * 【なぜ生成のたびに meeting_sheets へ残すか】
 * 表5-21 の summary_json は「生成時点の集約内容」。
 * 打ち合わせの場で見た内容を後から再現できないと、
 * 「あのとき何が未提出だったか」を追えなくなる（D03 は打ち合わせの根拠資料）。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { PrintButton } from './PrintButton';
import { SheetDraftPanel } from './SheetDraftPanel';
import { adoptedOutput, AI_JOB_COLUMNS, fetchAiAssistStatus, type AiJobRow } from '@/lib/ai/assist';
import { getAppUser, requirePageUser } from '@/lib/auth/session';
import {
  COUPLE_PROFILE_COLUMNS,
  FOLLOW_METHOD_LABEL,
  INCOMPLETE_TASK_STATUSES,
  TASK_STATUS_LABEL,
  type FollowMethod,
  type TaskStatus,
} from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { formatDate, formatDateJp, formatDateTime, todayInJst } from '@/lib/format';
import { daysBetween } from '@/lib/services/schedule';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface TaskRow {
  id: string;
  title: string;
  due_date: string;
  status: TaskStatus;
  display_order: number;
}

interface FollowRow {
  id: string;
  method: FollowMethod;
  note: string | null;
  followed_at: string;
  user_profiles: { display_name: string } | null;
}

interface CommRow {
  id: string;
  channel: string;
  direction: string;
  source: string;
  summary: string;
  occurred_at: string;
}

/**
 * 生成した内容を meeting_sheets に残す（機能4-5）。
 * 印刷の直前に呼ぶ想定だが、印刷はクライアント側の操作なので
 * 「記録する」を明示的な操作として置く。
 */
async function recordSheet(formData: FormData) {
  'use server';

  const caseId = String(formData.get('caseId') ?? '');
  const summary = String(formData.get('summary') ?? '{}');
  if (!caseId) return;

  const actor = await getAppUser();
  if (!actor) redirect('/login');

  const supabase = await createSupabaseServerClient();
  // meeting_sheets_all は staff 限定かつ案件スコープ（付録A）。権限は RLS が担保する。
  await supabase.from('meeting_sheets').insert({
    case_id: caseId,
    generated_by: actor.id,
    summary_json: JSON.parse(summary),
  });

  revalidatePath(`/cases/${caseId}/sheet`);
}

/**
 * 9-2 の下書きを依頼する（7-2／7-3）。
 *
 * LLM へ渡す文面をここで作るのがこの関数の要点。
 * 画面から文字列を受け取らないので、7-4「LLMへの入力は処理に必要な最小限の項目に限定する」を
 * クライアントの実装に依存せず守れる。
 * 渡すのは未提出宿題の件名・期限と連絡の要約だけで、氏名・連絡先は含めない。
 */
async function requestSheetDraft(formData: FormData) {
  'use server';

  const caseId = String(formData.get('caseId') ?? '');
  if (!caseId) return;

  const actor = await getAppUser();
  if (!actor) redirect('/login');

  const supabase = await createSupabaseServerClient();
  const today = todayInJst();

  const [tasks, comms] = await Promise.all([
    supabase.from('case_tasks')
      .select('title, due_date, status')
      .eq('case_id', caseId)
      .in('status', INCOMPLETE_TASK_STATUSES as unknown as string[])
      .order('due_date')
      .limit(20),
    supabase.from('communication_logs')
      .select('summary, occurred_at')
      .eq('case_id', caseId)
      .order('occurred_at', { ascending: false })
      .limit(10),
  ]);

  const pendingLines = ((tasks.data ?? []) as { title: string; due_date: string; status: TaskStatus }[])
    .map((t) => `・${t.title}（期限 ${formatDate(t.due_date.slice(0, 10))}／`
      + `${TASK_STATUS_LABEL[t.status]}）`);
  const commLines = ((comms.data ?? []) as { summary: string; occurred_at: string }[])
    .map((c) => `・${formatDate(c.occurred_at.slice(0, 10))} ${c.summary}`);

  const text = [
    `本日: ${formatDate(today)}`,
    pendingLines.length > 0
      ? `未提出の宿題:\n${pendingLines.join('\n')}`
      : '未提出の宿題: なし',
    commLines.length > 0
      ? `直近の連絡:\n${commLines.join('\n')}`
      : '直近の連絡: なし',
  ].join('\n\n');

  const { error } = await supabase.rpc('enqueue_ai_job', {
    p_case_id: caseId,
    p_job_type: 'draft',
    p_input_ref: { text, params: { purpose: 'meeting_sheet_summary' } },
    p_related_task_id: null,
  });
  if (error) console.warn('[sheet] 下書きを依頼できませんでした', error);

  revalidatePath(`/cases/${caseId}/sheet`);
}

export default async function MeetingSheetPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  await requirePageUser();

  const { caseId } = await params;
  const supabase = await createSupabaseServerClient();
  const today = todayInJst();

  const caseResult = await supabase
    .from('wedding_cases')
    .select('id, case_code, wedding_date, venue_room, guest_count, plan_types ( name ), user_profiles ( display_name )')
    .eq('id', caseId)
    .maybeSingle();
  if (!caseResult.data) redirect('/error?code=404');
  const target = caseResult.data as unknown as {
    id: string;
    case_code: string;
    wedding_date: string;
    venue_room: string | null;
    guest_count: number | null;
    plan_types: { name: string } | null;
    user_profiles: { display_name: string } | null;
  };

  const [profiles, tasks, follows, comms, sheets] = await Promise.all([
    supabase.from('couple_profiles').select(COUPLE_PROFILE_COLUMNS).eq('case_id', caseId),
    supabase.from('case_tasks')
      .select('id, title, due_date, status, display_order')
      .eq('case_id', caseId)
      .order('due_date').order('display_order').order('id'),
    supabase.from('follow_logs')
      .select('id, method, note, followed_at, user_profiles ( display_name )')
      .eq('case_id', caseId)
      .order('followed_at', { ascending: false })
      .limit(10),
    supabase.from('communication_logs')
      .select('id, channel, direction, source, summary, occurred_at')
      .eq('case_id', caseId)
      .order('occurred_at', { ascending: false })
      .limit(15),
    supabase.from('meeting_sheets')
      .select('id, generated_at')
      .eq('case_id', caseId)
      .order('generated_at', { ascending: false })
      .limit(1),
  ]);

  const coupleName = ((profiles.data ?? []) as unknown as
    { full_name: string; is_primary_contact: boolean }[])
    .slice()
    .sort((a, b) => Number(b.is_primary_contact) - Number(a.is_primary_contact))
    .map((p) => readPii(p.full_name))
    .filter(Boolean)
    .join('・');

  // 9-2 の下書き。この案件で宿題に紐づかない draft ジョブが該当する
  // （宿題ごとの下書きは 9-3 で、そちらは related_task_id を持つ）。
  const [aiStatus, draftJobs] = await Promise.all([
    fetchAiAssistStatus(supabase),
    supabase.from('ai_jobs')
      .select(AI_JOB_COLUMNS)
      .eq('case_id', caseId)
      .eq('job_type', 'draft')
      .is('related_task_id', null)
      .order('created_at', { ascending: false })
      .limit(1),
  ]);
  const draftJob = ((draftJobs.data ?? []) as unknown as AiJobRow[])[0] ?? null;
  const sheetDraft = draftJob?.status === 'confirmed'
    ? adoptedOutput('draft', draftJob)
    : null;

  const taskRows = (tasks.data ?? []) as unknown as TaskRow[];
  const done = taskRows.filter((t) => !INCOMPLETE_TASK_STATUSES.includes(t.status));
  const pending = taskRows.filter((t) => INCOMPLETE_TASK_STATUSES.includes(t.status));
  const followRows = (follows.data ?? []) as unknown as FollowRow[];
  const commRows = (comms.data ?? []) as unknown as CommRow[];
  const lastSheet = ((sheets.data ?? []) as { generated_at: string }[])[0] ?? null;

  const summary = {
    caseCode: target.case_code,
    generatedFor: today,
    totalTasks: taskRows.length,
    doneTasks: done.length,
    pendingTasks: pending.map((t) => ({ title: t.title, dueDate: t.due_date, status: t.status })),
  };

  return (
    <div className="space-y-4">
      {/* 印刷には出さない操作群 */}
      <div className="no-print space-y-4">
        <nav aria-label="パンくず">
          <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
            <li><Link href="/cases" className="text-link hover:underline">案件一覧</Link></li>
            <li aria-hidden>/</li>
            <li>
              <Link href={`/cases/${caseId}`} className="text-link hover:underline">
                {target.case_code}
              </Link>
            </li>
            <li aria-hidden>/</li>
            <li aria-current="page">打ち合わせ前準備シート</li>
          </ol>
        </nav>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="section-head">打ち合わせ前準備シート</h1>
          <div className="flex flex-wrap gap-3">
            <form action={recordSheet}>
              <input type="hidden" name="caseId" value={caseId} />
              <input type="hidden" name="summary" value={JSON.stringify(summary)} />
              <button type="submit" className="btn-secondary w-auto px-5">
                この内容を記録する
              </button>
            </form>
            {/* 6-11: 第一手段はブラウザ印刷。印刷ダイアログから PDF として保存もできる */}
            <PrintButton />
          </div>
        </div>

        {lastSheet && (
          <p className="text-caption text-text-muted">
            前回の記録: {formatDateTime(lastSheet.generated_at)}
          </p>
        )}

        <SheetDraftPanel
          initialJob={draftJob}
          aiAvailable={aiStatus.available}
          lastSeenAt={aiStatus.lastSeenAt}
          requestSlot={(
            <form action={requestSheetDraft}>
              <input type="hidden" name="caseId" value={caseId} />
              <button type="submit" className="btn-secondary w-auto px-5">
                AIに要点の下書きを頼む
              </button>
            </form>
          )}
        />
      </div>

      {/* ここから下が印刷対象 */}
      <article className="sheet space-y-5">
        <header className="border-b border-border-light pb-3">
          <h2 className="text-title font-bold text-text-primary">
            {coupleName || target.case_code} 様 打ち合わせ前準備シート
          </h2>
          <dl className="mt-2 grid grid-cols-2 gap-1 text-label sm:grid-cols-4">
            <Item label="案件番号" value={target.case_code} />
            <Item label="挙式日" value={`${formatDateJp(target.wedding_date.slice(0, 10))}（あと${daysBetween(target.wedding_date.slice(0, 10), today)}日）`} />
            <Item label="プラン" value={target.plan_types?.name ?? '未設定'} />
            <Item label="担当" value={target.user_profiles?.display_name ?? '—'} />
            <Item label="会場" value={target.venue_room ?? '—'} />
            <Item label="人数" value={`${target.guest_count ?? 0}名`} />
            <Item label="作成日" value={formatDate(today)} />
          </dl>
        </header>

        <section>
          <h3 className="section-head">宿題の進み具合</h3>
          <p className="mt-1 text-label text-text-secondary">
            {taskRows.length === 0
              ? '宿題はまだ割り当てられていません。'
              : `${taskRows.length}件中 ${done.length}件が完了しています。`}
          </p>

          {pending.length > 0 && (
            <>
              <h4 className="mt-3 text-label font-bold text-text-primary">
                これからご提出いただくもの（{pending.length}件）
              </h4>
              <table className="table mt-1">
                <thead>
                  <tr>
                    <th scope="col">宿題</th>
                    <th scope="col">期限</th>
                    <th scope="col">状態</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((task) => {
                    const remaining = daysBetween(task.due_date.slice(0, 10), today);
                    return (
                      <tr key={task.id}>
                        <td>{task.title}</td>
                        <td>
                          {formatDate(task.due_date.slice(0, 10))}
                          {remaining < 0 && (
                            <span className="ml-1 text-caption text-warning-text">
                              （{-remaining}日超過）
                            </span>
                          )}
                        </td>
                        <td>{TASK_STATUS_LABEL[task.status]}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}

          {done.length > 0 && (
            <p className="mt-2 text-caption text-text-muted">
              完了: {done.map((t) => t.title).join('、')}
            </p>
          )}
        </section>

        <section>
          <h3 className="section-head">直近の連絡</h3>
          {commRows.length === 0 ? (
            <p className="mt-1 text-label text-text-muted">記録はまだありません。</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {commRows.map((row) => (
                <li key={row.id} className="text-label text-text-secondary">
                  {formatDateTime(row.occurred_at)} ／ {row.summary}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="section-head">フォロー記録</h3>
          {followRows.length === 0 ? (
            <p className="mt-1 text-label text-text-muted">記録はまだありません。</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {followRows.map((row) => (
                <li key={row.id} className="text-label text-text-secondary">
                  {formatDateTime(row.followed_at)} ／ {FOLLOW_METHOD_LABEL[row.method]}
                  {row.user_profiles ? ` ／ ${row.user_profiles.display_name}` : ''}
                  {row.note ? ` ／ ${row.note}` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>

        {sheetDraft && (
          <section>
            <h3 className="section-head">要点（AIによる下書き・確認済み）</h3>
            {/* 7-1「AIが生成した文面・分類であることを画面上に明示する」。
                紙に出たあとも出所が分かるよう、見出しに残す */}
            <p className="mt-1 whitespace-pre-wrap text-label text-text-secondary">
              {sheetDraft.text}
            </p>
          </section>
        )}

        <section>
          <h3 className="section-head">打ち合わせメモ</h3>
          {/* 印刷して手書きで使えるよう余白を残す。入力欄にしないのは D05（Phase 3）と役割が違うため */}
          <div className="mt-1 h-32 rounded-card border border-border-light" />
        </section>
      </article>
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
