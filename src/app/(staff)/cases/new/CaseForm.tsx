'use client';

/**
 * K03 案件登録フォーム（4-3 表4-14）。
 *
 * 案件番号（case_code）は登録時にシステムが採番するため入力欄を持たない（5-7）。
 * 「登録する」は 6-6-2 で確定した2API構成のとおり
 *   POST /api/cases → POST /api/cases/{caseId}/assign-tasks
 * の順で呼ぶ。案件登録が成功した時点で招待URLの平文は二度と得られなくなるため（6-3-6）、
 * 宿題の一括割当が失敗しても登録完了モーダルは必ず開き、割当だけ後から再実行できる旨を伝える。
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { ApiCallError, api } from '@/lib/api/client';
import {
  CONTACT_CHANNEL_LABEL,
  INPUT_LIMITS,
  PARTNER_ROLES,
  PARTNER_ROLE_LABEL,
  SENDABLE_CHANNELS,
  type ContactChannel,
  type PartnerRole,
} from '@/lib/constants';
import { formatDate } from '@/lib/format';
import { dueDateFrom } from '@/lib/services/schedule';
import { InvitationResultModal, type IssuedInvitation } from './InvitationResultModal';

export interface PlanOption {
  id: string;
  name: string;
  templates: { id: string; name: string; dueOffsetDays: number }[];
}

interface CreateCaseResponse {
  caseId: string;
  caseCode: string;
  invitations: IssuedInvitation[];
}

interface Props {
  plans: PlanOption[];
  /**
   * 過去日付を選べないようにするための今日（日本時間の暦日）。
   * ブラウザのタイムゾーンで求めるとサーバー側 notPastDate と食い違い、
   * ハイドレーション差異も出るため props で受け取る。
   */
  today: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CASE_FIELD_ORDER = [
  'weddingDate',
  'weddingTime',
  'groomName',
  'brideName',
  'primaryContact',
  'contactEmail',
  'contactChannel',
  'guestCount',
  'planTypeId',
] as const;

export function CaseForm({ plans, today }: Props) {
  const [form, setForm] = useState({
    weddingDate: '',
    weddingTime: '',
    groomName: '',
    brideName: '',
    contactEmail: '',
    primaryContact: 'bride' as PartnerRole,
    contactChannel: 'email' as ContactChannel,
    guestCount: '',
    planTypeId: plans[0]?.id ?? '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<
    (CreateCaseResponse & { assigned: number; assignError: string | null }) | null
  >(null);

  useEffect(() => {
    const firstInvalid = CASE_FIELD_ORDER.find((field) => fieldErrors[field]);
    if (!firstInvalid) return;
    const input = document.getElementById(firstInvalid);
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [fieldErrors]);

  const fieldA11y = (field: string, helpId?: string) => {
    const invalid = Boolean(fieldErrors[field]);
    return {
      'aria-invalid': invalid || undefined,
      'aria-describedby':
        [helpId, invalid ? `${field}-error` : undefined].filter(Boolean).join(' ') || undefined,
    };
  };

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // 割当宿題プレビュー（4-3 K03）。期限は挙式日からの逆算（6-6-2）で、登録時と同じ関数を使う。
  const selectedPlan = plans.find((plan) => plan.id === form.planTypeId);
  const preview =
    selectedPlan && ISO_DATE.test(form.weddingDate)
      ? selectedPlan.templates.map((template) => ({
          id: template.id,
          name: template.name,
          dueDate: dueDateFrom(form.weddingDate, template.dueOffsetDays),
        }))
      : [];

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setSummary(null);
    setFieldErrors({});

    try {
      const created = await api.post<CreateCaseResponse>('/api/cases', {
        weddingDate: form.weddingDate,
        weddingTime: form.weddingTime === '' ? null : form.weddingTime,
        groomName: form.groomName,
        brideName: form.brideName,
        contactEmail: form.contactEmail,
        primaryContact: form.primaryContact,
        contactChannel: form.contactChannel,
        guestCount: form.guestCount === '' ? null : Number(form.guestCount),
        planTypeId: form.planTypeId,
      });

      let assigned = 0;
      let assignError: string | null = null;
      try {
        const assignment = await api.post<{ added: number }>(
          `/api/cases/${created.caseId}/assign-tasks`,
        );
        assigned = assignment.added;
      } catch (error) {
        // 案件は登録済み。案件詳細から再実行できる状態（6-6-2 の「正常に起こり得る状態」）
        assignError =
          error instanceof ApiCallError
            ? error.message
            : '宿題の割り当てが完了しませんでした。案件詳細から再度お試しください。';
      }

      setResult({ ...created, assigned, assignError });
    } catch (error) {
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
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <ErrorSummary message={summary} />

        <div className="card space-y-3">
          <p className="text-caption text-text-muted">
            案件番号は登録時に自動で採番されます。入力の必要はありません。
          </p>

          <div>
            <label htmlFor="weddingDate" className="field-label">
              挙式日（必須）
            </label>
            <input
              id="weddingDate"
              type="date"
              className="field"
              min={today}
              value={form.weddingDate}
              onChange={(e) => update('weddingDate', e.target.value)}
              {...fieldA11y('weddingDate')}
              required
            />
            <FieldError id="weddingDate-error" message={fieldErrors.weddingDate} />
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
              {...fieldA11y('weddingTime')}
            />
            <FieldError id="weddingTime-error" message={fieldErrors.weddingTime} />
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
              {...fieldA11y('groomName')}
              required
            />
            <FieldError id="groomName-error" message={fieldErrors.groomName} />
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
              {...fieldA11y('brideName')}
              required
            />
            <FieldError id="brideName-error" message={fieldErrors.brideName} />
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
              {...fieldA11y('primaryContact')}
            >
              {PARTNER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {PARTNER_ROLE_LABEL[role]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-caption text-text-muted">
              下の連絡先メールは、こちらで選んだ方の連絡先として登録します。
            </p>
            <FieldError id="primaryContact-error" message={fieldErrors.primaryContact} />
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
              {...fieldA11y('contactEmail')}
              required
            />
            <FieldError id="contactEmail-error" message={fieldErrors.contactEmail} />
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
              {...fieldA11y('contactChannel')}
            >
              {SENDABLE_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {CONTACT_CHANNEL_LABEL[channel]}
                </option>
              ))}
            </select>
            <FieldError id="contactChannel-error" message={fieldErrors.contactChannel} />
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
              inputMode="numeric"
              className="field"
              value={form.guestCount}
              onChange={(e) => update('guestCount', e.target.value)}
              {...fieldA11y('guestCount', 'guest-count-help')}
            />
            <p id="guest-count-help" className="mt-1 text-caption text-text-muted">
              人数が未定の場合は空欄にしてください。
            </p>
            <FieldError id="guestCount-error" message={fieldErrors.guestCount} />
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
              {...fieldA11y('planTypeId')}
              required
            >
              <option value="">選択してください</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
            <FieldError id="planTypeId-error" message={fieldErrors.planTypeId} />
          </div>
        </div>

        <section className="card space-y-2">
          <h2 className="section-head">割当宿題プレビュー</h2>
          {preview.length === 0 ? (
            <p className="text-label text-text-muted">
              挙式日とプラン種別を選ぶと、割り当てる宿題と期限を確認できます。
            </p>
          ) : (
            <ul className="space-y-1 text-label">
              {preview.map((item) => (
                <li
                  key={item.id}
                  className="flex justify-between gap-3 border-b border-border-light py-1"
                >
                  <span>{item.name}</span>
                  <span className="text-text-muted">{formatDate(item.dueDate)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex gap-3">
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? '登録しています…' : '登録する'}
          </button>
          <Link href="/cases" className="btn-secondary text-center">
            キャンセル
          </Link>
        </div>
      </form>

      {result && (
        <InvitationResultModal
          caseId={result.caseId}
          caseCode={result.caseCode}
          invitations={result.invitations}
          assignedCount={result.assigned}
          assignError={result.assignError}
        />
      )}
    </>
  );
}
