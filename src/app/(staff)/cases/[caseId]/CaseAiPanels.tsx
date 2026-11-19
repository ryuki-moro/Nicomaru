/**
 * K02 案件詳細の AI拡張パネル（Issue #118、9-8 リスケ / 9-9 引継ぎ / 9-10 テンプレート案）。
 *
 * 正本: 基本設計書 7-5。いずれも「案を出すだけ」で、登録・日付変更・送信は行わない（7-1）。
 * サーバー側で計算したルール結果（フォールバック）を最初から表示し、
 * AI ワーカーが居る場合はジョブ結果で上書きできるようにする二段構えにする。
 * これによりワーカー未起動のデモでも、各機能の意味と出力の形を確認できる。
 */
'use client';

import { useState } from 'react';

import { AiHeading, AiJobState, AiUnavailable } from '@/components/ai/AiNotice';
import { useAiJob, type AiJobView } from '@/components/ai/useAiJob';
import { FieldError } from '@/components/ui/ErrorSummary';
import { adoptedOutput } from '@/lib/ai/assist';
import type { HandoverSummaryOutput } from '@/lib/ai/handover';
import type { ReschedulePlanOutput, RescheduleShift } from '@/lib/ai/reschedule';
import type { TemplateDraftOutput } from '@/lib/ai/template-draft';
import { ApiCallError, api } from '@/lib/api/client';

interface Props {
  caseId: string;
  aiAvailable: boolean;
  lastSeenAt: string | null;
  handoverFallback: HandoverSummaryOutput;
  handoverJob: AiJobView | null;
  rescheduleFallback: ReschedulePlanOutput;
  rescheduleShifts: RescheduleShift[];
  rescheduleJob: AiJobView | null;
  templateFallback: TemplateDraftOutput;
  templateJob: AiJobView | null;
  /** テンプレート管理画面は admin だけが開ける（それ以外は 403 になるためリンクを出さない） */
  canRegisterTemplate: boolean;
}

function useExtJob(initial: AiJobView | null, caseId: string, jobType: string) {
  const { job, track, timedOut } = useAiJob(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function request(input: { text: string; params: Record<string, unknown> }) {
    setError(null);
    setPending(true);
    try {
      const created = await api.post<{ id: string }>('/api/ai/jobs', {
        caseId,
        jobType,
        input,
      });
      track({
        id: created.id,
        status: 'queued',
        output: null,
        reviewed_output: null,
        error_message: null,
      });
    } catch (cause) {
      setError(
        cause instanceof ApiCallError
          ? cause.message
          : '通信に失敗しました。時間をおいてお試しください',
      );
    } finally {
      setPending(false);
    }
  }
  return { job, request, pending, error, timedOut };
}

export function CaseAiPanels(props: Props) {
  const handover = useExtJob(props.handoverJob, props.caseId, 'handover_summary');
  const reschedule = useExtJob(props.rescheduleJob, props.caseId, 'reschedule_plan');
  const template = useExtJob(props.templateJob, props.caseId, 'template_draft');
  const [shiftDays, setShiftDays] = useState(7);

  const handoverOut = adoptedOutput('handover_summary', handover.job) ?? props.handoverFallback;
  const rescheduleOut =
    adoptedOutput('reschedule_plan', reschedule.job) ?? props.rescheduleFallback;
  const templateOut = adoptedOutput('template_draft', template.job) ?? props.templateFallback;

  return (
    <div className="space-y-4">
      {/* 9-9 引継ぎサマリー */}
      <section className="card">
        <AiHeading note="案件の状態を集約した引継ぎ用の要約です。内容を確認してから引き継ぎに使ってください。">
          AIによる引継ぎサマリー（要確認）
        </AiHeading>
        {!props.aiAvailable && (
          <AiUnavailable
            lastSeenAt={props.lastSeenAt}
            fallback="AIが使えないため、宿題の状態から自動集計した要約を表示しています。"
          />
        )}
        {handover.job && (
          <AiJobState
            status={handover.job.status}
            errorMessage={handover.job.error_message}
            fallback="集計による要約を表示しています。"
          />
        )}
        <p className="mt-2 whitespace-pre-wrap text-label text-text-primary">
          {handoverOut.summary}
        </p>
        {handoverOut.decisions.length > 0 && (
          <>
            <p className="mt-3 text-caption font-bold text-text-secondary">確定済み・決定事項</p>
            <ul className="list-disc pl-5 text-label text-text-primary">
              {handoverOut.decisions.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </>
        )}
        {handoverOut.cautions.length > 0 && (
          <>
            <p className="mt-3 text-caption font-bold text-text-secondary">注意点</p>
            <ul className="list-disc pl-5 text-label text-text-primary">
              {handoverOut.cautions.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </>
        )}
        <FieldError message={handover.error ?? undefined} />
        {props.aiAvailable && (
          <button
            type="button"
            className="btn-secondary mt-3 sm:w-56"
            disabled={handover.pending}
            onClick={() =>
              handover.request({
                text: handoverOut.summary,
                params: { source: 'handover_panel' },
              })
            }
          >
            {handover.pending ? '依頼中…' : 'AIにサマリーを作り直してもらう'}
          </button>
        )}
      </section>

      {/* 9-8 リスケジュール案 */}
      <section className="card">
        <AiHeading note="日付の計算はルールで行い、AIは説明文だけを作ります（設計書 7-5）。日付は自動では変わりません。">
          AIによるリスケジュール案（要確認）
        </AiHeading>
        {!props.aiAvailable && (
          <AiUnavailable
            lastSeenAt={props.lastSeenAt}
            fallback="AIが使えないため、ルール計算による案と定型の説明文を表示しています。"
          />
        )}
        {reschedule.job && (
          <AiJobState
            status={reschedule.job.status}
            errorMessage={reschedule.job.error_message}
            fallback="ルール計算による案を表示しています。"
          />
        )}
        <p className="mt-2 whitespace-pre-wrap text-label text-text-primary">
          {rescheduleOut.explanation}
        </p>
        {props.rescheduleShifts.length > 0 && (
          <div className="table-wrap mt-3">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">宿題</th>
                  <th scope="col">現在の期限</th>
                  <th scope="col">案</th>
                </tr>
              </thead>
              <tbody>
                {props.rescheduleShifts.map((s) => (
                  <tr key={s.id}>
                    <td>{s.title}</td>
                    <td>{s.from}</td>
                    <td>{s.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rescheduleOut.cautions.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-caption text-text-muted">
            {rescheduleOut.cautions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        )}
        <FieldError message={reschedule.error ?? undefined} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-caption text-text-muted" htmlFor="reschedule-shift">
            後ろ倒し日数（遅延が無い宿題向け）
          </label>
          <input
            id="reschedule-shift"
            type="number"
            min={0}
            max={90}
            className="field w-24"
            value={shiftDays}
            onChange={(e) => setShiftDays(Number(e.target.value))}
          />
          {props.aiAvailable && (
            <button
              type="button"
              className="btn-secondary sm:w-56"
              disabled={reschedule.pending}
              onClick={() =>
                reschedule.request({
                  text: rescheduleOut.explanation,
                  params: { shifts: props.rescheduleShifts, shiftDays },
                })
              }
            >
              {reschedule.pending ? '依頼中…' : 'AIに説明文を作ってもらう'}
            </button>
          )}
        </div>
        <p className="mt-2 text-caption text-text-muted">
          案を採用する場合は、案件編集で挙式日・期限を確認してから手動で反映してください。
        </p>
      </section>

      {/* 9-10 テンプレート案 */}
      <section className="card">
        <AiHeading
          note={`この案件のプランに不足している宿題テンプレートの案です。${
            props.canRegisterTemplate
              ? '登録はテンプレート管理画面から行ってください。'
              : '登録は式場管理者がテンプレート管理画面で行います。'
          }`}
        >
          AIによるテンプレート案（要確認）
        </AiHeading>
        {!props.aiAvailable && (
          <AiUnavailable
            lastSeenAt={props.lastSeenAt}
            fallback="AIが使えないため、標準的な準備項目から作った案を表示しています。"
          />
        )}
        {template.job && (
          <AiJobState
            status={template.job.status}
            errorMessage={template.job.error_message}
            fallback="ルールによる案を表示しています。"
          />
        )}
        {templateOut.templates.length === 0 ? (
          <p className="mt-2 text-label text-text-muted">
            追加の案はありません（標準的な項目は既に揃っています）。
          </p>
        ) : (
          <div className="table-wrap mt-2">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">宿題名（案）</th>
                  <th scope="col">説明</th>
                  <th scope="col">期限の目安</th>
                  <th scope="col">登録</th>
                </tr>
              </thead>
              <tbody>
                {templateOut.templates.map((t) => (
                  <tr key={t.name}>
                    <td>{t.name}</td>
                    <td>{t.description}</td>
                    <td>挙式{t.due_offset_days}日前</td>
                    <td>
                      {props.canRegisterTemplate ? (
                        <a className="btn-ghost" href="/templates/new">
                          テンプレート登録へ
                        </a>
                      ) : (
                        <span className="text-caption text-text-muted">管理者に依頼</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <FieldError message={template.error ?? undefined} />
        {props.aiAvailable && (
          <button
            type="button"
            className="btn-secondary mt-3 sm:w-56"
            disabled={template.pending}
            onClick={() =>
              template.request({
                text: templateOut.templates.map((t) => t.name).join('\n'),
                params: { source: 'template_panel' },
              })
            }
          >
            {template.pending ? '依頼中…' : 'AIに案を作り直してもらう'}
          </button>
        )}
      </section>
    </div>
  );
}
