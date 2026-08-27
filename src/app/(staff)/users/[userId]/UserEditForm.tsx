/**
 * U03 利用者変更フォームと U04 削除確認（admin／system_admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-20／U04 の記述／6-3-1。
 *   パスワードは本画面では扱わない（本人が P03 から設定・再設定する）。
 *   利用者種別・所属式場は変更不可。
 *   削除は論理削除で、担当案件のある planner は引き継ぎ先の指定が必須。
 *
 * Auth ユーザーの操作を伴うため、更新・削除は /api/admin/users/{userId} を経由する（6-3-5）。
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { api, ApiCallError } from '@/lib/api/client';
import { INPUT_LIMITS, USER_STATUS_LABEL } from '@/lib/constants';

/** 表4-20 の「状態」。deleted は U04 の削除でのみ付き、選択肢には出さない。 */
const EDITABLE_STATUSES = ['active', 'invited', 'suspended'] as const;
type EditableStatus = (typeof EDITABLE_STATUSES)[number];

export interface SuccessorOption {
  id: string;
  displayName: string;
}

interface Props {
  userId: string;
  roleLabel: string;
  venueName: string;
  initial: {
    displayName: string;
    email: string;
    phone: string;
    status: EditableStatus;
  };
  /** ログイン中の本人かどうか。U04「ログイン中の自身は削除不可」 */
  isSelf: boolean;
  /** 担当案件数。0 より大きい planner は引き継ぎ先の指定が必須 */
  assignedCaseCount: number;
  successorOptions: SuccessorOption[];
}

export function UserEditForm({
  userId,
  roleLabel,
  venueName,
  initial,
  isSelf,
  assignedCaseCount,
  successorOptions,
}: Props) {
  const router = useRouter();

  const [displayName, setDisplayName] = useState(initial.displayName);
  const [email, setEmail] = useState(initial.email);
  const [phone, setPhone] = useState(initial.phone);
  const [status, setStatus] = useState<EditableStatus>(initial.status);

  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [successorId, setSuccessorId] = useState('');

  const reset = () => {
    setSummary(null);
    setNotice(null);
    setFieldErrors({});
  };

  const handleApiError = (error: unknown) => {
    if (error instanceof ApiCallError) {
      // 4-3 エラー表示規約: 権限エラー・不存在は P04 へ遷移する
      if (error.status === 403 || error.status === 404) {
        router.push(`/error?code=${error.status}`);
        return;
      }
      setSummary(error.message);
      setFieldErrors(error.fieldErrors);
    } else {
      setSummary('通信に失敗しました。時間をおいてお試しください');
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    reset();
    setSaving(true);
    try {
      await api.patch(`/api/admin/users/${userId}`, {
        displayName,
        email,
        phone: phone.trim() === '' ? null : phone,
        status,
      });
      setNotice('変更を保存しました。');
      router.refresh();
    } catch (error) {
      handleApiError(error);
    } finally {
      setSaving(false);
    }
  };

  const handleResend = async () => {
    reset();
    setSaving(true);
    try {
      const result = await api.patch<{ mailDelivered: boolean | null }>(
        `/api/admin/users/${userId}`,
        { resendInviteLink: true },
      );
      setNotice(
        result.mailDelivered
          ? '初回パスワード設定リンクを再送しました。'
          : 'リンクは発行しましたが、メールを送信できませんでした。メール設定を確認してください。',
      );
    } catch (error) {
      handleApiError(error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    reset();
    setSaving(true);
    try {
      await api.del(`/api/admin/users/${userId}`, {
        ...(successorId ? { successorPlannerId: successorId } : {}),
      });
      router.push('/users');
      router.refresh();
    } catch (error) {
      handleApiError(error);
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} noValidate className="card space-y-4">
        <ErrorSummary message={summary} />
        {notice && <p className="banner-info">{notice}</p>}

        <div>
          <label className="field-label" htmlFor="user-name">
            氏名（必須）
          </label>
          <input
            id="user-name"
            className="field"
            value={displayName}
            maxLength={INPUT_LIMITS.shortText}
            onChange={(e) => setDisplayName(e.target.value)}
            aria-invalid={fieldErrors.displayName ? true : undefined}
          />
          <FieldError message={fieldErrors.displayName} />
        </div>

        <div>
          <label className="field-label" htmlFor="user-email">
            メールアドレス（必須）
          </label>
          <input
            id="user-email"
            className="field"
            type="email"
            autoComplete="off"
            value={email}
            maxLength={255}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={fieldErrors.email ? true : undefined}
          />
          <p className="mt-1 text-caption text-text-muted">
            変更すると、ログインに使うメールアドレスも同時に切り替わります。
          </p>
          <FieldError message={fieldErrors.email} />
        </div>

        <div>
          <label className="field-label" htmlFor="user-phone">
            電話番号（任意・数字とハイフン）
          </label>
          <input
            id="user-phone"
            className="field"
            inputMode="tel"
            value={phone}
            maxLength={30}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={fieldErrors.phone ? true : undefined}
          />
          <FieldError message={fieldErrors.phone} />
        </div>

        <div>
          <label className="field-label" htmlFor="user-status">
            状態（必須）
          </label>
          <select
            id="user-status"
            className="field"
            value={status}
            onChange={(e) => setStatus(e.target.value as EditableStatus)}
          >
            {EDITABLE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {USER_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
          {status === 'suspended' && (
            <p className="mt-1 text-caption text-text-muted">
              停止中にすると、この利用者はすぐにログインできなくなります。あとから利用中に戻せます。
            </p>
          )}
          <FieldError message={fieldErrors.status} />
        </div>

        <div className="flex flex-wrap gap-6">
          <div>
            <span className="field-label">利用者種別</span>
            <p className="text-label">{roleLabel}</p>
          </div>
          <div>
            <span className="field-label">所属式場</span>
            <p className="text-label">{venueName}</p>
          </div>
        </div>
        <p className="text-caption text-text-muted">
          利用者種別と所属式場は変更できません。変更が必要な場合は、削除してから登録し直してください。
        </p>

        <div className="flex gap-3 pt-2">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? '処理しています…' : '変更を保存'}
          </button>
          <Link href="/users" className="btn-secondary block text-center">
            一覧に戻る
          </Link>
        </div>
      </form>

      {initial.status === 'invited' && (
        <section className="card space-y-2">
          <h2 className="section-head">初回パスワード設定リンク</h2>
          <p className="text-label text-text-secondary">
            まだパスワードが設定されていません。リンクの期限が切れている場合は、ここから再送できます。
          </p>
          <button
            type="button"
            className="btn-secondary w-auto"
            disabled={saving}
            onClick={handleResend}
          >
            設定リンクを再送する
          </button>
        </section>
      )}

      <section className="card space-y-2">
        <h2 className="section-head">この利用者を削除</h2>
        {isSelf ? (
          <p className="text-label text-text-secondary">
            ログイン中のご自身のアカウントは削除できません。
          </p>
        ) : !confirmingDelete ? (
          <>
            <p className="text-label text-text-secondary">
              削除しても記録は残り、ログインだけができなくなります。
              {assignedCaseCount > 0
                && `担当中の案件が${assignedCaseCount}件あるため、引き継ぎ先のプランナーの指定が必要です。`}
            </p>
            <button
              type="button"
              className="btn-secondary w-auto"
              disabled={saving}
              onClick={() => {
                reset();
                setConfirmingDelete(true);
              }}
            >
              削除に進む
            </button>
          </>
        ) : (
          <>
            <p role="alert" className="banner-error">
              {initial.displayName} さんを削除します。よろしいですか。
            </p>

            {assignedCaseCount > 0 && (
              <div>
                <label className="field-label" htmlFor="successor">
                  引き継ぎ先のプランナー（必須）
                </label>
                <select
                  id="successor"
                  className="field"
                  value={successorId}
                  onChange={(e) => setSuccessorId(e.target.value)}
                  aria-invalid={fieldErrors.successorPlannerId ? true : undefined}
                >
                  <option value="">選択してください</option>
                  {successorOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.displayName}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-caption text-text-muted">
                  担当中の{assignedCaseCount}件の案件が、選んだプランナーの担当に切り替わります。
                </p>
                <FieldError message={fieldErrors.successorPlannerId} />
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                className="btn-primary"
                disabled={saving}
                onClick={handleDelete}
              >
                {saving ? '処理しています…' : '削除する'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={saving}
                onClick={() => setConfirmingDelete(false)}
              >
                やめる
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
