/**
 * D05 打ち合わせ記録・宿題起票のD1版（Wave2）。
 *
 * src/lib/d1/meeting.ts（meeting_notes 0015＋D1 AI基盤 task_extraction）で行う。
 * 起票案の確認・登録は TaskProposalPanel が既存の宿題追加API（D1対応済み）を使う。
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { Breadcrumbs, DASHBOARD_CRUMB } from '@/components/layout/Breadcrumbs';
import { getAppUser } from '@/lib/auth/session';
import { INPUT_LIMITS, isStaff } from '@/lib/constants';
import { caseRow } from '@/lib/d1/cases';
import { extractionState, listNotes, saveNote } from '@/lib/d1/meeting';
import { localDB } from '@/lib/d1/runtime';
import { formatDate, formatDateTime, todayInJst } from '@/lib/format';
import { TaskProposalPanel } from './TaskProposalPanel';

export const dynamic = 'force-dynamic';

async function saveMeetingNoteAction(formData: FormData) {
  'use server';
  const caseId = String(formData.get('caseId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const meetingDate = String(formData.get('meetingDate') ?? '').trim();
  const participants = String(formData.get('participants') ?? '').trim();
  if (!caseId || body === '') return;
  const actor = await getAppUser();
  if (!actor || !isStaff(actor.role)) redirect('/login');
  await saveNote(await localDB(), actor, {
    caseId,
    body,
    meetingDate: meetingDate === '' ? null : meetingDate,
    participants: participants === '' ? null : participants,
  }).catch((error: unknown) => {
    console.warn('[meeting-notes] 記録を保存できませんでした', error);
  });
  revalidatePath(`/cases/${caseId}/meeting-notes`);
}

export async function MeetingNotesPageD1({
  caseId,
  user,
}: {
  caseId: string;
  user: { id: string; role: string };
}) {
  const db = await localDB();
  const actor = user as Parameters<typeof caseRow>[1];
  let target: Awaited<ReturnType<typeof caseRow>>;
  try {
    target = await caseRow(db, actor, caseId);
  } catch {
    redirect('/error?code=404');
  }
  const t = target!;
  const [noteRows, { status: aiStatus, job: latestJob }] = await Promise.all([
    listNotes(db, actor, caseId).catch(() => []),
    extractionState(db, actor, caseId),
  ]);
  const archived = t.archived_at !== null;

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          DASHBOARD_CRUMB,
          { label: '案件一覧', href: '/cases' },
          { label: t.case_code, href: `/cases/${caseId}` },
          { label: '打ち合わせ記録' },
        ]}
      />
      <h1 className="section-head">打ち合わせ記録</h1>

      {archived ? (
        <p className="banner-info">
          <span>アーカイブ済みの案件のため、記録の追加はできません。</span>
        </p>
      ) : (
        <section className="card">
          <h2 className="text-label font-bold text-text-primary">打ち合わせの記録</h2>
          <p className="mb-3 mt-1 text-caption text-text-muted">
            決まったこと・宿題になりそうなことを書いてください。
            保存すると、AIが宿題の案を作ります。
          </p>
          <form action={saveMeetingNoteAction} className="space-y-3">
            <input type="hidden" name="caseId" value={caseId} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="field-label" htmlFor="meetingDate">
                  打ち合わせ日
                </label>
                <input
                  id="meetingDate"
                  name="meetingDate"
                  type="date"
                  className="field"
                  defaultValue={todayInJst()}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="participants">
                  参加者
                </label>
                <input
                  id="participants"
                  name="participants"
                  type="text"
                  className="field"
                  maxLength={INPUT_LIMITS.shortText}
                  placeholder="新郎新婦、担当プランナー など"
                />
              </div>
            </div>
            <div>
              <label className="field-label" htmlFor="body">
                メモ（必須）
              </label>
              <textarea
                id="body"
                name="body"
                rows={8}
                required
                maxLength={INPUT_LIMITS.textArea}
                className="field"
                placeholder="BGMは新婦が候補を出す／引き出物はカタログAで内定、最終確定は次回 など"
              />
            </div>
            <button type="submit" className="btn-primary sm:w-48">
              記録して案を作る
            </button>
          </form>
        </section>
      )}

      {/* 保存のたびに新しいジョブが届く。key で作り直し、新しいジョブの完了を待ち受ける */}
      <TaskProposalPanel
        key={latestJob?.id ?? 'none'}
        caseId={caseId}
        initialJob={latestJob}
        aiAvailable={aiStatus.available}
        lastSeenAt={aiStatus.lastSeenAt}
      />

      <section className="card">
        <h2 className="text-label font-bold text-text-primary">これまでの記録</h2>
        {noteRows.length === 0 ? (
          <p className="mt-1 text-label text-text-muted">記録はまだありません。</p>
        ) : (
          <ul className="mt-2 space-y-3">
            {noteRows.map((note) => (
              <li key={note.id} className="border-b border-border-light pb-3 last:border-b-0">
                <p className="text-caption text-text-muted">
                  {note.meeting_date
                    ? formatDate(note.meeting_date)
                    : formatDateTime(note.created_at)}
                  {note.participants && ` ／ ${note.participants}`}
                  {note.user_profiles && ` ／ ${note.user_profiles.display_name}`}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-label text-text-primary">{note.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
