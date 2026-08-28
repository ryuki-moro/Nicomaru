/**
 * S02 式場登録・編集フォーム（表4-21、機能8-2／8-3、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 S02／表4-21／5-7。
 *
 *   式場名・式場コード（英大文字＋数字、全式場で一意。採番規約は 5-7）・式場代表メール・
 *   管理者氏名・管理者メールアドレス（新規登録時必須）・利用中
 *
 * 管理者には初期パスワードを発行せず、U02 と同じ初回パスワード設定リンクを送る（6-3-1）。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { api, handleApiError } from '@/lib/api/client';
import { INPUT_LIMITS } from '@/lib/constants';

interface CreateResponse {
  id: string;
  adminCreated: boolean;
  reason?: string | null;
  mailDelivered?: boolean;
  mailReason?: string | null;
}

export function VenueForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [active, setActive] = useState(true);
  const [pending, setPending] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CreateResponse | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSummaryError(null);
    setFieldErrors({});
    setPending(true);
    try {
      const response = await api.post<CreateResponse>('/api/venues', {
        name,
        code: code.trim().toUpperCase(),
        contactEmail: contactEmail.trim() === '' ? null : contactEmail.trim(),
        adminName: adminName.trim() === '' ? undefined : adminName.trim(),
        adminEmail: adminEmail.trim() === '' ? undefined : adminEmail.trim(),
        active,
      });
      setResult(response);
      router.refresh();
    } catch (error) {
      // 4-3 エラー表示規約: 権限エラー・不存在は P04 へ遷移する
      handleApiError(error, router, {
        onSummary: setSummaryError,
        onFieldErrors: setFieldErrors,
      });
    } finally {
      setPending(false);
    }
  }

  if (result) {
    return (
      <div className="card space-y-3">
        <h2 className="section-head">式場を登録しました</h2>
        {result.adminCreated ? (
          <p className="text-label text-text-secondary">
            {result.mailDelivered
              ? '式場管理者へ初回パスワード設定のご案内を送信しました。'
              : `初回パスワード設定のご案内は送信されていません（${result.mailReason ?? '送信未構成'}）。`}
          </p>
        ) : (
          <p className="text-label text-text-secondary">
            管理者アカウントは作成していません{result.reason ? `（${result.reason}）` : ''}。
            利用者管理から追加してください。
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <a href="/venues" className="btn-secondary w-auto px-5 text-center">式場一覧へ戻る</a>
          <a href={`/venues/${result.id}`} className="btn-ghost">この式場を開く</a>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-4">
      <ErrorSummary message={summaryError} />

      <div>
        <label htmlFor="name" className="field-label">式場名（必須）</label>
        <input id="name" className="field" value={name} maxLength={INPUT_LIMITS.shortText}
          onChange={(e) => setName(e.target.value)} required />
        <FieldError message={fieldErrors.name} />
      </div>

      <div>
        <label htmlFor="code" className="field-label">
          式場コード（必須・英大文字と数字で4〜10字。全式場で一意）
        </label>
        <input id="code" className="field uppercase" value={code} maxLength={10}
          onChange={(e) => setCode(e.target.value)} required />
        <FieldError message={fieldErrors.code} />
        <p className="mt-1 text-caption text-text-muted">
          案件番号の先頭に使われます（例 BRIDAL01-2026-0001）。あとから変更できません。
        </p>
      </div>

      <div>
        <label htmlFor="contactEmail" className="field-label">式場代表メール（任意）</label>
        <input id="contactEmail" type="email" className="field" value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)} />
        <FieldError message={fieldErrors.contactEmail} />
      </div>

      <fieldset className="space-y-3 rounded-card border border-border-light p-3">
        <legend className="px-1 text-caption text-text-muted">式場管理者（新規登録時）</legend>
        <div>
          <label htmlFor="adminName" className="field-label">管理者氏名</label>
          <input id="adminName" className="field" value={adminName}
            maxLength={INPUT_LIMITS.shortText}
            onChange={(e) => setAdminName(e.target.value)} />
          <FieldError message={fieldErrors.adminName} />
        </div>
        <div>
          <label htmlFor="adminEmail" className="field-label">管理者メールアドレス</label>
          <input id="adminEmail" type="email" className="field" value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)} />
          <FieldError message={fieldErrors.adminEmail} />
          <p className="mt-1 text-caption text-text-muted">
            初期パスワードは発行しません。ご本人がパスワードを設定するリンクをお送りします。
          </p>
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-label">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        利用中
      </label>

      <button type="submit" className="btn-primary" disabled={pending}>
        {pending ? '登録中…' : '登録する'}
      </button>
    </form>
  );
}
