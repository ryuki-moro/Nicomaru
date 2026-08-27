'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { api, ApiCallError } from '@/lib/api/client';
import { INPUT_LIMITS, OTP } from '@/lib/constants';
import { OtpInput } from '@/app/(public)/login/LoginForm';

/** /api/auth/initial-register の応答（6-6-1）。 */
type RegisterResponse =
  | { status: 'verification_required'; email: string }
  | { status: 'registered'; sessionEstablished: boolean; redirectTo: string };

/**
 * コード入力の目的。
 *   - 'verify'  : LINE案内（recipient_email が NULL）の招待。検証できるまで案件へ紐付けない（6-6-1）
 *   - 'session' : 登録は済んだがサーバー側でセッションを確立できなかった場合の代替経路
 */
type OtpPurpose = 'verify' | 'session';

/**
 * P02 初回登録フォーム（表4-12）。
 *   メールアドレス（必須・メール形式・重複）／氏名（必須）／利用規約同意（必須）。
 *   パスワードは設定せず、登録完了と同時にワンタイム認証でセッションを確立する（6-3-1）。
 */
export function RegisterForm({ token }: { token: string }) {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);

  const [otpPurpose, setOtpPurpose] = useState<OtpPurpose | null>(null);
  const [code, setCode] = useState('');
  const [resendIn, setResendIn] = useState(0);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setInterval(() => setResendIn((current) => Math.max(current - 1, 0)), 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  const handleFailure = (cause: unknown, fallbackMessage: string) => {
    if (cause instanceof ApiCallError) {
      setError(cause.message);
      setFieldErrors(cause.fieldErrors);
      return;
    }
    setError(fallbackMessage);
  };

  const sendCode = async (purpose: OtpPurpose) => {
    await api.post('/api/auth/otp-request', { email });
    setOtpPurpose(purpose);
    setCode('');
    setResendIn(OTP.resendIntervalSeconds);
    setNotice(
      purpose === 'verify'
        ? `${email} 宛に確認コードをお送りしました。ご本人さま確認のため、6桁のコードをご入力ください。`
        : `${email} 宛にログイン用の6桁のコードをお送りしました。`,
    );
  };

  /** 登録要求。確認コード検証後の再送信でも同じ経路を通る（サーバー側で冪等に扱う）。 */
  const submitRegistration = async (): Promise<boolean> => {
    const result = await api.post<RegisterResponse>('/api/auth/initial-register', {
      token,
      email,
      fullName,
      termsAccepted,
    });

    if (result.status === 'verification_required') {
      await sendCode('verify');
      return false;
    }
    if (!result.sessionEstablished) {
      await sendCode('session');
      return false;
    }
    router.replace(result.redirectTo);
    router.refresh();
    return true;
  };

  const register = async () => {
    setPending(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    try {
      await submitRegistration();
    } catch (cause) {
      handleFailure(cause, '登録できませんでした。時間をおいて再度お試しください');
    } finally {
      setPending(false);
    }
  };

  const verifyCode = async (submitted: string) => {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await api.post<{ redirectTo: string }>('/api/auth/otp-verify', {
        email,
        code: submitted,
      });
      if (otpPurpose === 'verify') {
        // 本人確認が済んだので、同じ招待トークンでもう一度登録要求を出して案件へ紐付ける（6-6-1）
        setNotice(null);
        await submitRegistration();
        return;
      }
      router.replace(result.redirectTo);
      router.refresh();
    } catch (cause) {
      handleFailure(cause, '確認できませんでした。時間をおいて再度お試しください');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="card flex flex-col gap-4">
      <ErrorSummary message={error} />

      {notice && !error && (
        <div role="status" className="banner-info">
          <span>{notice}</span>
        </div>
      )}

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          if (otpPurpose) return void verifyCode(code);
          return void register();
        }}
      >
        <div>
          <label className="field-label" htmlFor="register-email">
            メールアドレス
          </label>
          <input
            id="register-email"
            className="field"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            disabled={pending || otpPurpose !== null}
            placeholder="you@example.com"
            value={email}
            aria-invalid={fieldErrors.email ? true : undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
          <FieldError message={fieldErrors.email} />
        </div>

        <div>
          <label className="field-label" htmlFor="register-name">
            お名前
          </label>
          <input
            id="register-name"
            className="field"
            type="text"
            autoComplete="name"
            required
            maxLength={INPUT_LIMITS.shortText}
            disabled={pending || otpPurpose !== null}
            placeholder="山田 太郎"
            value={fullName}
            aria-invalid={fieldErrors.fullName ? true : undefined}
            onChange={(event) => setFullName(event.target.value)}
          />
          <FieldError message={fieldErrors.fullName} />
        </div>

        {otpPurpose === null && (
          <div>
            {/* design_guide 5.13 同意チェック行 */}
            <label className="flex items-start gap-2 text-caption text-text-secondary">
              <input
                type="checkbox"
                className="mt-[2px] h-4 w-4 accent-primary"
                checked={termsAccepted}
                disabled={pending}
                aria-invalid={fieldErrors.termsAccepted ? true : undefined}
                onChange={(event) => setTermsAccepted(event.target.checked)}
              />
              <span>利用規約と個人情報の取り扱いに同意します</span>
            </label>
            <FieldError message={fieldErrors.termsAccepted} />
            <button
              type="button"
              className="btn-ghost mt-1 text-caption"
              onClick={() => setTermsOpen(true)}
            >
              利用規約を見る
            </button>
          </div>
        )}

        {otpPurpose !== null && (
          <div>
            <span className="field-label">
              {otpPurpose === 'verify' ? '確認コード（6桁）' : 'ワンタイムコード（6桁）'}
            </span>
            <OtpInput
              value={code}
              onChange={setCode}
              onComplete={(completed) => void verifyCode(completed)}
              disabled={pending}
              invalid={Boolean(fieldErrors.code)}
            />
            <FieldError message={fieldErrors.code} />
          </div>
        )}

        <button type="submit" className="btn-primary" disabled={pending}>
          {otpPurpose === null ? '登録してマイページへ' : '確認してマイページへ'}
        </button>
      </form>

      {otpPurpose !== null && (
        <button
          type="button"
          className="btn-ghost self-center"
          disabled={pending || resendIn > 0}
          onClick={() => {
            setError(null);
            void sendCode(otpPurpose).catch((cause: unknown) =>
              handleFailure(cause, 'メールを送信できませんでした。時間をおいてお試しください'),
            );
          }}
        >
          {resendIn > 0 ? `コードを再送信（${resendIn}秒後）` : 'コードを再送信する'}
        </button>
      )}

      {termsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-text-primary/40 px-4 pb-6"
          role="dialog"
          aria-modal="true"
          aria-label="利用規約"
        >
          <div className="card max-h-[70vh] w-full max-w-phone overflow-y-auto">
            <h2 className="section-head mb-2">利用規約（要約）</h2>
            <ul className="flex flex-col gap-2 text-label text-text-secondary">
              <li>
                本サービスは、結婚式の準備状況をプランナーとおふたりで共有するためのものです。
              </li>
              <li>
                ログインはメールアドレス宛のワンタイム認証で行います。
                メールアドレスの管理がそのままアカウントの保護になりますので、
                受信できる端末・アカウントの管理にご注意ください。
              </li>
              <li>
                ご入力いただいた個人情報は、担当プランナーと式場の管理者のみが確認します。
                案件の終了後は一定期間を経て削除します。
              </li>
              <li>ご招待いただくゲストの情報を代理でご入力いただく場合があります。</li>
            </ul>
            <button
              type="button"
              className="btn-secondary mt-4"
              onClick={() => setTermsOpen(false)}
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
