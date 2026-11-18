/**
 * D03 準備シートのD1版（Wave2）。
 *
 * src/lib/d1/sheet.ts（meeting_sheets 0014＋D1 AI基盤）で行う。
 * フォロー記録・連絡履歴は D1 にテーブルが無いため空として表示する（別Waveで移行）。
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { Breadcrumbs, DASHBOARD_CRUMB } from '@/components/layout/Breadcrumbs';
import { adoptedOutput } from '@/lib/ai/assist';
import { getAppUser } from '@/lib/auth/session';
import { INCOMPLETE_TASK_STATUSES, TASK_STATUS_LABEL } from '@/lib/constants';
import { localDB } from '@/lib/d1/runtime';
import { recordSheet, requestSheetDraft, sheetData, sheetDraftState } from '@/lib/d1/sheet';
import { formatDate, formatDateJp, formatDateTime, todayInJst } from '@/lib/format';
import { daysBetween } from '@/lib/services/schedule';
import { PrintButton } from './PrintButton';
import { SheetDraftPanel } from './SheetDraftPanel';

export const dynamic = 'force-dynamic';

async function recordSheetAction(formData: FormData) {
  'use server';
  const caseId = String(formData.get('caseId') ?? '');
  const summary = String(formData.get('summary') ?? '{}');
  if (!caseId) return;
  const actor = await getAppUser();
  if (!actor) redirect('/login');
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(summary);
  } catch {
    parsed = {};
  }
  await recordSheet(await localDB(), actor, caseId, parsed).catch((error: unknown) => {
    console.warn('[sheet] 記録できませんでした', error);
  });
  revalidatePath(`/cases/${caseId}/sheet`);
}

async function requestSheetDraftAction(formData: FormData) {
  'use server';
  const caseId = String(formData.get('caseId') ?? '');
  if (!caseId) return;
  const actor = await getAppUser();
  if (!actor) redirect('/login');
  await requestSheetDraft(await localDB(), actor, caseId).catch((error: unknown) => {
    console.warn('[sheet] 下書きを依頼できませんでした', error);
  });
  revalidatePath(`/cases/${caseId}/sheet`);
}

export async function MeetingSheetPageD1({
  caseId,
  user,
}: {
  caseId: string;
  user: { id: string; role: string };
}) {
  const db = await localDB();
  const actor = user as Parameters<typeof sheetData>[1];
  let data: Awaited<ReturnType<typeof sheetData>>;
  try {
    data = await sheetData(db, actor, caseId);
  } catch {
    redirect('/error?code=404');
  }
  const { target, lastSheet } = data!;
  const today = todayInJst();
  const { status: aiStatus, job: draftJob } = await sheetDraftState(db, actor, caseId);
  const sheetDraft = draftJob?.status === 'confirmed' ? adoptedOutput('draft', draftJob) : null;

  const coupleName = target.couple_profiles
    .slice()
    .sort((a, b) => Number(b.is_primary_contact) - Number(a.is_primary_contact))
    .map((p) => p.full_name)
    .filter(Boolean)
    .join('・');
  const taskRows = target.case_tasks;
  const done = taskRows.filter((t) => !INCOMPLETE_TASK_STATUSES.includes(t.status));
  const pending = taskRows.filter((t) => INCOMPLETE_TASK_STATUSES.includes(t.status));
  const summary = {
    caseCode: target.case_code,
    generatedFor: today,
    totalTasks: taskRows.length,
    doneTasks: done.length,
    pendingTasks: pending.map((t) => ({ title: t.title, dueDate: t.due_date, status: t.status })),
  };

  return (
    <div className="space-y-4">
      <div className="no-print space-y-4">
        <Breadcrumbs
          items={[
            DASHBOARD_CRUMB,
            { label: '案件一覧', href: '/cases' },
            { label: target.case_code, href: `/cases/${caseId}` },
            { label: '打ち合わせ前準備シート' },
          ]}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="section-head">打ち合わせ前準備シート</h1>
          <div className="flex flex-wrap gap-3">
            <form action={recordSheetAction}>
              <input type="hidden" name="caseId" value={caseId} />
              <input type="hidden" name="summary" value={JSON.stringify(summary)} />
              <button type="submit" className="btn-secondary w-auto px-5">
                この内容を記録する
              </button>
            </form>
            <PrintButton />
          </div>
        </div>
        {lastSheet && (
          <p className="text-caption text-text-muted">
            前回の記録: {formatDateTime(lastSheet.generated_at)}
          </p>
        )}
        <SheetDraftPanel
          key={draftJob?.id ?? 'none'}
          initialJob={draftJob}
          aiAvailable={aiStatus.available}
          lastSeenAt={aiStatus.lastSeenAt}
          requestSlot={
            <form action={requestSheetDraftAction}>
              <input type="hidden" name="caseId" value={caseId} />
              <button type="submit" className="btn-secondary w-auto px-5">
                AIに要点の下書きを頼む
              </button>
            </form>
          }
        />
      </div>

      <article className="sheet space-y-5">
        <header className="border-b border-border-light pb-3">
          <h2 className="text-title font-bold text-text-primary">
            {coupleName || target.case_code} 様 打ち合わせ前準備シート
          </h2>
          <dl className="mt-2 grid grid-cols-2 gap-1 text-label sm:grid-cols-4">
            <Item label="案件番号" value={target.case_code} />
            <Item
              label="挙式日"
              value={`${formatDateJp(target.wedding_date.slice(0, 10))}（あと${daysBetween(target.wedding_date.slice(0, 10), today)}日）`}
            />
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
          <p className="mt-1 text-label text-text-muted">
            記録はまだありません。（連絡履歴はD1への移行が別途必要です）
          </p>
        </section>

        <section>
          <h3 className="section-head">フォロー記録</h3>
          <p className="mt-1 text-label text-text-muted">
            記録はまだありません。（フォロー記録はD1への移行が別途必要です）
          </p>
        </section>

        {sheetDraft && (
          <section>
            <h3 className="section-head">要点（AIによる下書き・確認済み）</h3>
            <p className="mt-1 whitespace-pre-wrap text-label text-text-secondary">
              {sheetDraft.text}
            </p>
          </section>
        )}

        <section>
          <h3 className="section-head">打ち合わせメモ</h3>
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
