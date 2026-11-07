'use client';
import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { api, ApiCallError } from '@/lib/api/client';
import { PASSWORD_MIN_LENGTH } from '@/lib/constants';
import { passwordUpdateSchema, toErrorDetails } from '@/lib/validation';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
type Mode = 'reset' | 'invite';
/** 'checking' = リンク由来のセッションを確立できるか判定中 */
type Step = 'checking' | 'request' | 'update';
const COPY: Record<
  Mode,
  {
    title: string;
    lead: string;
    submit: string;
  }
> = {
  reset: {
    title: 'パスワードの再設定',
    lead: '新しいパスワードを設定してください。',
    submit: 'パスワードを変更する',
  },
  invite: {
    title: 'パスワードの初期設定',
    lead: 'はじめてのログインに使うパスワードを設定してください。',
    submit: 'パスワードを設定してログインへ',
  },
};
/**
 * P03 の2ステップ（4-3 P03）。
 *
 * ステップ2 は「再設定リンク」と「初回パスワード設定リンク（generateLink type=invite）」の
 * 共通の着地画面である。どちらもメール内リンクから戻ると PKCE の code（または実装トークン）が
 * URL に付くので、それをセッションへ交換できたときだけ新パスワード入力を表示する。
 *
 * パスワード要件は 6-3-1／13-1 のとおり12文字以上。
 * アプリ側では拒否理由を利用者向けの文言に変換するだけにする。
 * リストをアプリ側に持つと更新が追随できず、判定が形骸化するため。
 */
export function PasswordForms({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [token, setToken] = useState<string | null>(null);
  // メール内リンクからの着地処理。初回マウント時に1度だけ行う。
  useEffect(() => {
    let cancelled = false;
    {
      // D1はリンクのフラグメントにトークンを載せる。検証は送信時にサーバーで行う。
      const linkToken = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
      if (linkToken)
        window.history.replaceState(null, '', `${window.location.pathname}?mode=${mode}`);
      void Promise.resolve().then(() => {
        if (cancelled) return;
        setToken(linkToken);
        setStep(linkToken ? 'update' : 'request');
      });
      return () => {
        cancelled = true;
      };
    }
  }, [mode]);
  const requestReset = async () => {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.post('/api/auth/password-reset', { email });
      // 送信有無で応答を変えないため、画面の文言も「送った場合は届く」という形にする
      setNotice(
        `${email} にご登録がある場合、再設定用のリンクをお送りしました。` +
          'メールをご確認ください。',
      );
    } catch (cause) {
      if (cause instanceof ApiCallError) {
        setError(cause.message);
        setFieldErrors(cause.fieldErrors);
      } else {
        setError('メールを送信できませんでした。時間をおいてお試しください');
      }
    } finally {
      setPending(false);
    }
  };
  const updatePassword = async () => {
    setError(null);
    setFieldErrors({});
    // 12文字以上・一致の検証はサーバーと同じスキーマで行う（6-5-1 の details[] と同じ形に写像）
    const parsed = passwordUpdateSchema.safeParse({ password, passwordConfirm });
    if (!parsed.success) {
      const details = toErrorDetails(parsed.error);
      setFieldErrors(Object.fromEntries(details.map((d) => [d.field, d.reason])));
      setError('入力内容をご確認ください');
      return;
    }
    setPending(true);
    if (token) {
      try {
        await api.post('/api/auth/password-update', { ...parsed.data, token });
      } catch (cause) {
        setPending(false);
        setError(
          cause instanceof ApiCallError
            ? cause.message
            : 'パスワード設定を完了できませんでした。時間をおいてお試しください',
        );
        return;
      }
      router.replace('/login?mode=password&reset=done');
      router.refresh();
      return;
    }
    setPending(false);
    setError('リンクが無効です。再設定リンクを再発行してください');
  };
  const copy = COPY[mode];
  if (step === 'checking') {
    return <p className="card text-center text-label text-text-muted">確認しています…</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-title font-bold text-text-primary">
          {step === 'update' ? copy.title : 'パスワードの再設定'}
        </h1>
        <p className="mt-1 text-label text-text-muted">
          {step === 'update'
            ? copy.lead
            : 'ご登録のメールアドレス宛に、再設定用のリンクをお送りします。'}
        </p>
      </div>

      <div className="card flex flex-col gap-4">
        <ErrorSummary message={error} />

        {notice && !error && (
          <div role="status" className="banner-info">
            <span>{notice}</span>
          </div>
        )}

        {step === 'request' ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!pending) void requestReset();
            }}
          >
            <div>
              <label className="field-label" htmlFor="reset-email">
                メールアドレス
              </label>
              <input
                id="reset-email"
                className="field"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                disabled={pending}
                placeholder="you@example.com"
                value={email}
                aria-invalid={fieldErrors.email ? true : undefined}
                aria-describedby={fieldErrors.email ? 'reset-email-error' : undefined}
                onChange={(event) => setEmail(event.target.value)}
              />
              <FieldError id="reset-email-error" message={fieldErrors.email} />
            </div>
            <button type="submit" className="btn-primary" disabled={pending}>
              再設定リンクを送信
            </button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!pending) void updatePassword();
            }}
          >
            <div>
              <label className="field-label" htmlFor="new-password">
                新しいパスワード（{PASSWORD_MIN_LENGTH}文字以上）
              </label>
              <input
                id="new-password"
                className="field"
                type="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                disabled={pending}
                value={password}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={fieldErrors.password ? 'new-password-error' : undefined}
                onChange={(event) => setPassword(event.target.value)}
              />
              <FieldError id="new-password-error" message={fieldErrors.password} />
            </div>

            <div>
              <label className="field-label" htmlFor="new-password-confirm">
                新しいパスワード（確認）
              </label>
              <input
                id="new-password-confirm"
                className="field"
                type="password"
                autoComplete="new-password"
                required
                disabled={pending}
                value={passwordConfirm}
                aria-invalid={fieldErrors.passwordConfirm ? true : undefined}
                aria-describedby={
                  fieldErrors.passwordConfirm ? 'new-password-confirm-error' : undefined
                }
                onChange={(event) => setPasswordConfirm(event.target.value)}
              />
              <FieldError id="new-password-confirm-error" message={fieldErrors.passwordConfirm} />
            </div>

            <button type="submit" className="btn-primary" disabled={pending}>
              {copy.submit}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
