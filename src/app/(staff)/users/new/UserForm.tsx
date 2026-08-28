/**
 * U02 利用者登録フォーム（admin／system_admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-19／6-3-1。
 *   初期パスワードは発行せず、登録時に初回パスワード設定リンクを送信する。
 *   利用者種別・所属式場は表示のみで、実際の値はサーバー側が決める（6-3-5 表6-4）。
 *
 * 送信先は /api/admin/users。Auth Admin API を使う処理なので、
 * ここだけは Supabase クライアント直呼びではなく Route Handler を経由する（6-5）。
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { api, handleApiError } from '@/lib/api/client';
import { INPUT_LIMITS } from '@/lib/constants';

interface VenueOption {
  id: string;
  name: string;
}

interface Props {
  /** 表4-19「利用者種別（表示のみ・自動設定）」 */
  roleLabel: string;
  /** admin が登録する場合の所属式場名。表示のみ */
  fixedVenueName: string | null;
  /**
   * system_admin が登録する場合の対象式場。
   * 表4-19 は「S02 で指定した式場」を前提とするが、S01〜S03 は Phase 2 のため、
   * Phase 1 では登録前に対象式場を選ぶ導線をここに置く（4-3 の Phase 注記）。
   */
  venueOptions: VenueOption[];
}

interface CreatedUser {
  displayName: string;
  email: string;
  mailDelivered: boolean;
}

export function UserForm({ roleLabel, fixedVenueName, venueOptions }: Props) {
  const router = useRouter();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  // 既定で先頭式場を選んでおくと誤登録に気付けないため、明示的に選ばせる
  const [venueId, setVenueId] = useState('');

  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<CreatedUser | null>(null);

  const needsVenueChoice = fixedVenueName === null;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSummary(null);
    setFieldErrors({});

    if (needsVenueChoice && !venueId) {
      setFieldErrors({ venueId: '登録先の式場を選んでください' });
      return;
    }

    setSaving(true);
    try {
      const response = await api.post<{ user: { displayName: string; email: string }; mailDelivered: boolean }>(
        '/api/admin/users',
        {
          displayName,
          email,
          phone: phone.trim() === '' ? null : phone,
          // admin が呼ぶ場合はサーバー側で無視され、呼び出し元の venue_id に固定される
          ...(needsVenueChoice ? { venueId } : {}),
        },
      );
      setCreated({
        displayName: response.user.displayName,
        email: response.user.email,
        mailDelivered: response.mailDelivered,
      });
      setDisplayName('');
      setEmail('');
      setPhone('');
    } catch (error) {
      // 4-3 エラー表示規約: 権限エラー・不存在は P04 へ遷移する
      handleApiError(error, router, {
        onSummary: setSummary,
        onFieldErrors: setFieldErrors,
      });
    } finally {
      setSaving(false);
    }
  };

  if (created) {
    return (
      <div className="card space-y-3">
        <h2 className="section-head">登録が完了しました</h2>
        <p className="text-label">
          {created.displayName} さん（{created.email}）を{roleLabel}として登録しました。
        </p>
        {created.mailDelivered ? (
          <p className="banner-info">
            初回パスワード設定のご案内メールをお送りしました。
            ご本人がパスワードを設定すると、ログインできるようになります。
          </p>
        ) : (
          <p role="alert" className="banner-error">
            アカウントは作成できましたが、案内メールを送信できませんでした。
            利用者一覧からこの利用者を開き、設定リンクを再送してください。
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-secondary w-auto" onClick={() => setCreated(null)}>
            続けて登録する
          </button>
          <Link href="/users" className="btn-primary inline-block w-auto text-center">
            一覧に戻る
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="card space-y-4">
      <ErrorSummary message={summary} />

      <p className="banner-info">
        パスワードはこちらでは設定しません。登録すると、ご本人あてに初回パスワード設定リンクをお送りします。
        設定が完了するまでの状態は「招待済」になります。
      </p>

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
        <span className="field-label">利用者種別</span>
        <p className="text-label">{roleLabel}</p>
        <p className="mt-1 text-caption text-text-muted">
          登録者の権限に応じて自動で決まります。この画面では変更できません。
        </p>
      </div>

      {needsVenueChoice ? (
        <div>
          <label className="field-label" htmlFor="user-venue">
            所属式場（必須）
          </label>
          <select
            id="user-venue"
            className="field"
            value={venueId}
            onChange={(e) => setVenueId(e.target.value)}
            aria-invalid={fieldErrors.venueId ? true : undefined}
          >
            <option value="">選択してください</option>
            {venueOptions.map((venue) => (
              <option key={venue.id} value={venue.id}>
                {venue.name}
              </option>
            ))}
          </select>
          <FieldError message={fieldErrors.venueId} />
        </div>
      ) : (
        <div>
          <span className="field-label">所属式場</span>
          <p className="text-label">{fixedVenueName}</p>
          <p className="mt-1 text-caption text-text-muted">
            ご自身の所属式場に固定されます。この画面では変更できません。
          </p>
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? '登録しています…' : '登録して案内メールを送る'}
        </button>
        <Link href="/users" className="btn-secondary block text-center">
          キャンセル
        </Link>
      </div>
    </form>
  );
}
