'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { api, handleApiError } from '@/lib/api/client';
import { INPUT_LIMITS } from '@/lib/constants';

interface VenueValues {
  name: string;
  contactEmail: string | null;
  active: boolean;
}

interface Props {
  venueId: string;
  code: string;
  initial: VenueValues;
}

/** S02 式場の変更。管理者アカウントの操作は利用者管理で行う。 */
export function VenueEditForm({ venueId, code, initial }: Props) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [contactEmail, setContactEmail] = useState(initial.contactEmail ?? '');
  const [active, setActive] = useState(initial.active);
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setSummary(null);
    setNotice(null);
    setFieldErrors({});

    try {
      const saved = await api.patch<VenueValues>(`/api/venues/${venueId}`, {
        name: name.trim(),
        contactEmail: contactEmail.trim() === '' ? null : contactEmail.trim(),
        active,
      });
      setName(saved.name);
      setContactEmail(saved.contactEmail ?? '');
      setActive(saved.active);
      setNotice('変更を保存しました。');
      router.refresh();
    } catch (error) {
      handleApiError(error, router, {
        onSummary: setSummary,
        onFieldErrors: setFieldErrors,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-4" aria-label="式場の変更" noValidate>
      <ErrorSummary message={summary} />
      {notice && <p role="status" className="banner-info">{notice}</p>}

      <fieldset disabled={pending} className="space-y-4">
        <legend className="sr-only">式場情報</legend>

        <div>
          <label htmlFor="venue-code" className="field-label">式場コード（変更不可）</label>
          <input id="venue-code" className="field" value={code} readOnly
            aria-describedby="venue-code-hint" />
          <p id="venue-code-hint" className="mt-1 text-caption text-text-muted">
            案件番号の先頭に使われるため、変更できません。
          </p>
        </div>

        <div>
          <label htmlFor="venue-name" className="field-label">式場名（必須）</label>
          <input id="venue-name" className="field" value={name} maxLength={INPUT_LIMITS.shortText}
            onChange={(event) => { setName(event.target.value); setNotice(null); }} required
            aria-invalid={fieldErrors.name ? true : undefined}
            aria-describedby={fieldErrors.name ? 'venue-name-error' : undefined} />
          {fieldErrors.name && (
            <div id="venue-name-error"><FieldError message={fieldErrors.name} /></div>
          )}
        </div>

        <div>
          <label htmlFor="venue-contact-email" className="field-label">式場代表メール（任意）</label>
          <input id="venue-contact-email" type="email" className="field" value={contactEmail}
            onChange={(event) => { setContactEmail(event.target.value); setNotice(null); }}
            aria-invalid={fieldErrors.contactEmail ? true : undefined}
            aria-describedby={fieldErrors.contactEmail ? 'venue-contact-email-error' : undefined} />
          {fieldErrors.contactEmail && (
            <div id="venue-contact-email-error"><FieldError message={fieldErrors.contactEmail} /></div>
          )}
        </div>

        <div>
          <label htmlFor="venue-active" className="flex items-center gap-2 text-label">
            <input id="venue-active" type="checkbox" checked={active}
              onChange={(event) => { setActive(event.target.checked); setNotice(null); }}
              aria-invalid={fieldErrors.active ? true : undefined}
              aria-describedby={fieldErrors.active ? 'venue-active-hint venue-active-error' : 'venue-active-hint'} />
            利用中
          </label>
          <p id="venue-active-hint" className="mt-1 text-caption text-text-muted">
            チェックを外すと、式場一覧では「停止中」と表示されます。
          </p>
          {fieldErrors.active && (
            <div id="venue-active-error"><FieldError message={fieldErrors.active} /></div>
          )}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn-primary w-auto px-5" disabled={pending}>
          {pending ? '保存中…' : '変更を保存'}
        </button>
        <Link href="/venues" className="btn-secondary w-auto px-5 text-center">式場一覧へ戻る</Link>
      </div>
    </form>
  );
}
