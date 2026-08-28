/**
 * D05 打ち合わせ記録・宿題起票（planner、Phase 3）。
 *
 * 正本: 基本設計書 4-3 D05／7-2 の 9-5／7-3。
 *
 *   「打ち合わせメモ・ヒアリングメモを入力（meeting_notes）。
 *     AI（9-5）が抽出した宿題起票案（宿題名・説明・期限の目安）を
 *     『AIによる起票案（要確認）』として提示。
 *     プランナーが承認・修正した案のみ宿題（case_tasks）として登録」
 *
 * 記録の保存とジョブ投入はサーバーアクションで行う（7-3「打ち合わせ記録登録を契機とする
 * ジョブは…サーバー側処理から内部呼び出しで投入」）。
 * 起票案の確認・登録は TaskProposalPanel（クライアント）が担う。
 *
 * D04 フォロー記録とは別の画面。D04 は「連絡したこと」の記録で、
 * こちらは「打ち合わせで決まったこと」の記録。宿題の元になるのは後者。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { TaskProposalPanel } from './TaskProposalPanel';
import {
  AI_JOB_COLUMNS,
  fetchAiAssistStatus,
  trimForAi,
  type AiJobRow,
} from '@/lib/ai/assist';
import { getAppUser } from '@/lib/auth/session';
import { INPUT_LIMITS, isStaff } from '@/lib/constants';
import { formatDate, formatDateTime, todayInJst } from '@/lib/format';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface NoteRow {
  id: string;
  meeting_date: string | null;
  participants: string | null;
  body: string;
  created_at: string;
  user_profiles: { display_name: string } | null;
}

/**
 * 打ち合わせ記録を保存し、9-5 のジョブを投入する。
 *
 * 保存が成功してからジョブを投入する。逆順にすると、
 * 保存に失敗したメモを根拠に宿題案が出てしまう。
 * ジョブ投入に失敗しても記録は残す（AI は補助。7-1）。
 */
async function saveMeetingNote(formData: FormData) {
  'use server';

  const caseId = String(formData.get('caseId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const meetingDate = String(formData.get('meetingDate') ?? '').trim();
  const participants = String(formData.get('participants') ?? '').trim();
  if (!caseId || body === '') return;

  const actor = await getAppUser();
  if (!actor || !isStaff(actor.role)) redirect('/login');

  const supabase = await createSupabaseServerClient();
  // meeting_notes_all は staff 限定かつ案件スコープ（付録A）。範囲は RLS が担保する。
  const { data, error } = await supabase
    .from('meeting_notes')
    .insert({
      case_id: caseId,
      created_by: actor.id,
      meeting_date: meetingDate === '' ? null : meetingDate,
      participants: participants === '' ? null : participants,
      body: body.slice(0, INPUT_LIMITS.textArea),
    })
    .select('id')
    .single();
  if (error || !data) {
    console.warn('[meeting-notes] 記録を保存できませんでした', error);
    return;
  }

  // 7-4「LLMへの入力は処理に必要な最小限の項目に限定する」。
  // 渡すのはメモ本文だけ。参加者名や案件番号は起票案に要らない。
  const text = trimForAi(body);
  if (text) {
    const enqueued = await supabase.rpc('enqueue_ai_job', {
      p_case_id: caseId,
      p_job_type: 'task_extraction',
      p_input_ref: {
        ref: { table: 'meeting_notes', id: (data as { id: string }).id },
        text,
        params: {},
      },
      p_related_task_id: null,
    });
    if (enqueued.error) {
      console.warn('[meeting-notes] 起票案を依頼できませんでした', enqueued.error);
    }
  }

  revalidatePath(`/cases/${caseId}/meeting-notes`);
}

export default async function MeetingNotesPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const user = await getAppUser();
  if (!user) redirect('/login');
  // couple には打ち合わせ記録そのものを見せない（付録A meeting_notes_all は staff 限定）
  if (!isStaff(user.role)) redirect('/error?code=403');

  const { caseId } = await params;
  const supabase = await createSupabaseServerClient();

  const caseResult = await supabase
    .from('wedding_cases')
    .select('id, case_code, wedding_date, archived_at')
    .eq('id', caseId)
    .maybeSingle();
  if (!caseResult.data) redirect('/error?code=404');
  const target = caseResult.data as {
    id: string; case_code: string; wedding_date: string; archived_at: string | null;
  };

  const [notes, jobs, aiStatus] = await Promise.all([
    supabase.from('meeting_notes')
      .select('id, meeting_date, participants, body, created_at, user_profiles ( display_name )')
      .eq('case_id', caseId)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase.from('ai_jobs')
      .select(AI_JOB_COLUMNS)
      .eq('case_id', caseId)
      .eq('job_type', 'task_extraction')
      .order('created_at', { ascending: false })
      .limit(1),
    fetchAiAssistStatus(supabase),
  ]);

  const noteRows = (notes.data ?? []) as unknown as NoteRow[];
  const latestJob = ((jobs.data ?? []) as unknown as AiJobRow[])[0] ?? null;
  // アーカイブ済み案件は記録の追加も宿題の追加もできない（K05／2-5）
  const archived = target.archived_at !== null;

  return (
    <div className="space-y-5">
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
          <li aria-current="page">打ち合わせ記録</li>
        </ol>
      </nav>

      <h1 className="section-head">打ち合わせ記録・宿題起票</h1>

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

          <form action={saveMeetingNote} className="space-y-3">
            <input type="hidden" name="caseId" value={caseId} />

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="field-label" htmlFor="meetingDate">打ち合わせ日</label>
                <input
                  id="meetingDate"
                  name="meetingDate"
                  type="date"
                  className="field"
                  defaultValue={todayInJst()}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="participants">参加者</label>
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
              <label className="field-label" htmlFor="body">メモ（必須）</label>
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

            <button type="submit" className="btn-primary sm:w-48">記録して案を作る</button>
          </form>
        </section>
      )}

      <TaskProposalPanel
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
                  {note.meeting_date ? formatDate(note.meeting_date) : formatDateTime(note.created_at)}
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
