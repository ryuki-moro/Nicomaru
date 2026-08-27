'use client';

/**
 * K04 案件変更フォーム（4-3 K04）。
 *
 * K03 と同一項目（登録済み値を初期表示。案件番号は変更不可）に「担当プランナー」を加える。
 * 挙式日またはプラン種別を変更した場合は、確定前に差分確認ダイアログを表示する（6-6-2）。
 *   - 期限が変わる宿題と新旧の期限
 *   - プラン変更で追加される宿題
 *   - 対応不要（waived）になる宿題
 *
 * PATCH は confirmed:true を受け取るまで書き込みを行わず、差分だけを返す。
 * つまり「1回目の送信＝プレビュー取得」「2回目の送信＝適用」であり、
 * 画面に出した差分とDBへ適用される内容が必ず一致する。
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { ApiCallError, api } from '@/lib/api/client';
import {
  CONTACT_CHANNELS,
  CONTACT_CHANNEL_LABEL,
  INPUT_LIMITS,
  PARTNER_ROLES,
  PARTNER_ROLE_LABEL,
  type ContactChannel,
  type PartnerRole,
} from '@/lib/constants';

export interface CaseEditInitial {
  weddingDate: string;
  weddingTime: string;
  groomName: string;
  brideName: string;
  contactEmail: string;
  primaryContact: PartnerRole;
  contactChannel: ContactChannel;
  guestCount: string;
  planTypeId: string;
  primaryPlannerId: string;
}

interface PlanChangePreview {
  weddingDate: string;
  planChanged: boolean;
  dueChanges: { id: string; title: string; from: string; to: string }[];
  waived: { id: string; title: string }[];
  added: { taskTemplateId: string; title: string; dueDate: string }[];
}

interface PatchResponse {
  applied: boolean;
  preview?: PlanChangePreview;
}

interface Props {
  caseId: string;
  caseCode: string;
  initial: CaseEditInitial;
  plans: { id: string; name: string }[];
  /** 自式場の planner 一覧。admin 以外には渡さない（担当プランナーの変更は admin のみ） */
  planners: { id: string; displayName: string }[] | null;
}

const formatDate = (value: string) => value.replaceAll('-', '/');

export function CaseEditForm({ caseId, caseCode, initial, plans, planners }: Props) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);

  const update = <K extends keyof CaseEditInitial>(key: K, value: CaseEditInitial[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  /** 変更があった項目だけを送る。未変更の項目を送らないことで、DB側の部分更新と一致させる。 */
  function buildPayload(confirmed: boolean) {
    const payload: Record<string, unknown> = { confirmed };
    if (form.weddingDate !== initial.weddingDate) payload.weddingDate = form.weddingDate;
    if (form.weddingTime !== initial.weddingTime) {
      payload.weddingTime = form.weddingTime === '' ? null : form.weddingTime;
    }
    if (form.groomName !== initial.groomName) payload.groomName = form.groomName;
    if (form.brideName !== initial.brideName) payload.brideName = form.brideName;
    if (form.contactEmail !== initial.contactEmail) payload.contactEmail = form.contactEmail;
    if (form.primaryContact !== initial.primaryContact) payload.primaryContact = form.primaryContact;
    if (form.contactChannel !== initial.contactChannel) payload.contactChannel = form.contactChannel;
    if (form.guestCount !== initial.guestCount) {
      payload.guestCount = form.guestCount === '' ? null : Number(form.guestCount);
    }
    if (form.planTypeId !== initial.planTypeId) payload.planTypeId = form.planTypeId;
    if (planners && form.primaryPlannerId !== initial.primaryPlannerId) {
      payload.primaryPlannerId = form.primaryPlannerId;
    }
    return payload;
  }

  async function submit(confirmed: boolean) {
    if (submitting) return;
    setSubmitting(true);
    setSummary(null);
    setFieldErrors({});

    try {
      const result = await api.patch<PatchResponse>(`/api/cases/${caseId}`, buildPayload(confirmed));
      if (!result.applied && result.preview) {
        setPreview(result.preview);
        return;
      }
      router.push(`/cases/${caseId}`);
      router.refresh();
    } catch (error) {
      setPreview(null);
      if (error instanceof ApiCallError) {
        setSummary(error.message);
        setFieldErrors(error.fieldErrors);
      } else {
        setSummary('通信に失敗しました。時間をおいてもう一度お試しください。');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
        className="space-y-4"
        noValidate
      >
        <ErrorSummary message={summary} />

        <div className="card space-y-3">
          <div>
            <span className="field-label">案件番号</span>
            <p className="text-label">{caseCode}（変更できません）</p>
          </div>

          <div>
            <label htmlFor="weddingDate" className="field-label">
              挙式日（必須）
            </label>
            <input
              id="weddingDate"
              type="date"
              className="field"
              value={form.weddingDate}
              onChange={(e) => update('weddingDate', e.target.value)}
              required
            />
            <FieldError message={fieldErrors.weddingDate} />
          </div>

          <div>
            <label htmlFor="weddingTime" className="field-label">
              挙式開始時刻（任意）
            </label>
            <input
              id="weddingTime"
              type="time"
              className="field"
              value={form.weddingTime}
              onChange={(e) => update('weddingTime', e.target.value)}
            />
            <FieldError message={fieldErrors.weddingTime} />
          </div>

          <div>
            <label htmlFor="groomName" className="field-label">
              新郎氏名（必須）
            </label>
            <input
              id="groomName"
              className="field"
              maxLength={INPUT_LIMITS.shortText}
              value={form.groomName}
              onChange={(e) => update('groomName', e.target.value)}
              required
            />
            <FieldError message={fieldErrors.groomName} />
          </div>

          <div>
            <label htmlFor="brideName" className="field-label">
              新婦氏名（必須）
            </label>
            <input
              id="brideName"
              className="field"
              maxLength={INPUT_LIMITS.shortText}
              value={form.brideName}
              onChange={(e) => update('brideName', e.target.value)}
              required
            />
            <FieldError message={fieldErrors.brideName} />
          </div>

          <div>
            <label htmlFor="primaryContact" className="field-label">
              主連絡先（必須）
            </label>
            <select
              id="primaryContact"
              className="field"
              value={form.primaryContact}
              onChange={(e) => update('primaryContact', e.target.value as PartnerRole)}
            >
              {PARTNER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {PARTNER_ROLE_LABEL[role]}
                </option>
              ))}
            </select>
            <FieldError message={fieldErrors.primaryContact} />
          </div>

          <div>
            <label htmlFor="contactEmail" className="field-label">
              連絡先（メール・必須）
            </label>
            <input
              id="contactEmail"
              type="email"
              className="field"
              value={form.contactEmail}
              onChange={(e) => update('contactEmail', e.target.value)}
              required
            />
            <FieldError message={fieldErrors.contactEmail} />
          </div>

          <div>
            <label htmlFor="contactChannel" className="field-label">
              連絡起点（必須）
            </label>
            <select
              id="contactChannel"
              className="field"
              value={form.contactChannel}
              onChange={(e) => update('contactChannel', e.target.value as ContactChannel)}
            >
              {CONTACT_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {CONTACT_CHANNEL_LABEL[channel]}
                </option>
              ))}
            </select>
            <FieldError message={fieldErrors.contactChannel} />
          </div>

          <div>
            <label htmlFor="guestCount" className="field-label">
              人数（任意）
            </label>
            <input
              id="guestCount"
              type="number"
              min={0}
              step={1}
              className="field"
              value={form.guestCount}
              onChange={(e) => update('guestCount', e.target.value)}
            />
            <FieldError message={fieldErrors.guestCount} />
          </div>

          <div>
            <label htmlFor="planTypeId" className="field-label">
              プラン種別（必須）
            </label>
            <select
              id="planTypeId"
              className="field"
              value={form.planTypeId}
              onChange={(e) => update('planTypeId', e.target.value)}
              required
            >
              <option value="">選択してください</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
            <FieldError message={fieldErrors.planTypeId} />
          </div>

          {planners && (
            <div>
              <label htmlFor="primaryPlannerId" className="field-label">
                担当プランナー
              </label>
              <select
                id="primaryPlannerId"
                className="field"
                value={form.primaryPlannerId}
                onChange={(e) => update('primaryPlannerId', e.target.value)}
              >
                {planners.map((planner) => (
                  <option key={planner.id} value={planner.id}>
                    {planner.displayName}
                  </option>
                ))}
              </select>
              <FieldError message={fieldErrors.primaryPlannerId} />
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? '確認しています…' : '更新する'}
          </button>
          <Link href={`/cases/${caseId}`} className="btn-secondary text-center">
            キャンセル
          </Link>
        </div>
      </form>

      {preview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="case-diff-title"
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-text-primary/40 p-4"
        >
          <div className="card mt-8 w-full max-w-2xl space-y-4">
            <h2 id="case-diff-title" className="section-head">
              変更内容の確認
            </h2>
            <p className="text-label text-text-secondary">
              挙式日{preview.planChanged ? '・プラン種別' : ''}の変更にともない、宿題の内容が次のように変わります。
            </p>

            <section>
              <h3 className="text-label font-medium">期限が変わる宿題（{preview.dueChanges.length}件）</h3>
              {preview.dueChanges.length === 0 ? (
                <p className="text-caption text-text-muted">ありません。</p>
              ) : (
                <ul className="text-label">
                  {preview.dueChanges.map((change) => (
                    <li key={change.id} className="flex justify-between gap-3 border-b border-border-light py-1">
                      <span>{change.title}</span>
                      <span className="text-text-muted">
                        {formatDate(change.from)} → {formatDate(change.to)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="text-label font-medium">追加される宿題（{preview.added.length}件）</h3>
              {preview.added.length === 0 ? (
                <p className="text-caption text-text-muted">ありません。</p>
              ) : (
                <ul className="text-label">
                  {preview.added.map((task) => (
                    <li
                      key={task.taskTemplateId}
                      className="flex justify-between gap-3 border-b border-border-light py-1"
                    >
                      <span>{task.title}</span>
                      <span className="text-text-muted">{formatDate(task.dueDate)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="text-label font-medium">対応不要になる宿題（{preview.waived.length}件）</h3>
              {preview.waived.length === 0 ? (
                <p className="text-caption text-text-muted">ありません。</p>
              ) : (
                <ul className="text-label">
                  {preview.waived.map((task) => (
                    <li key={task.id} className="border-b border-border-light py-1">
                      {task.title}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-caption text-text-muted">
                対応不要にした宿題は削除されず、マイページでは「対応不要」と表示されます。
              </p>
            </section>

            <div className="flex gap-3">
              <button
                type="button"
                className="btn-primary"
                disabled={submitting}
                onClick={() => void submit(true)}
              >
                この内容で更新する
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setPreview(null)}
                disabled={submitting}
              >
                やめる
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
