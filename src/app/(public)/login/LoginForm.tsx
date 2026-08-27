'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { api, ApiCallError } from '@/lib/api/client';
import { OTP } from '@/lib/constants';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

/**
 * ワンタイムコード入力（design_guide 5.4）。
 * 6マス横並び、各 36×44px・角丸8px。既定は border-mid 1px、入力中は primary 2px。
 *
 * P02 の確認コード入力（6-6-1 のLINE案内経路）でも同じ見た目を使うため export する。
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const focusAt = (index: number) => {
    refs.current[Math.min(Math.max(index, 0), OTP.length - 1)]?.focus();
  };

  const commit = (next: string) => {
    onChange(next);
    if (next.length === OTP.length) onComplete?.(next);
  };

  return (
    <div className="flex justify-between gap-2" role="group" aria-label="ワンタイムコード">
      {Array.from({ length: OTP.length }, (_, index) => (
        <input
          key={index}
          ref={(element) => {
            refs.current[index] = element;
          }}
          value={value[index] ?? ''}
          disabled={disabled}
          type="text"
          inputMode="numeric"
          // ブラウザ・iOS のSMS／メール自動入力に載せる
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          aria-label={`ワンタイムコード ${index + 1}桁目`}
          aria-invalid={invalid || undefined}
          className={[
            'h-11 w-9 rounded-field bg-surface text-center text-base text-text-primary',
            'focus:border-2 focus:border-primary focus:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            invalid ? 'border border-danger' : 'border border-border-mid',
          ].join(' ')}
          onChange={(event) => {
            const digit = event.target.value.replace(/\D/g, '').slice(-1);
            if (!digit) return;
            // 途中のマスに入力したときは以降を捨てる。桁の抜けが起きない形に正規化する。
            commit((value.slice(0, index) + digit).slice(0, OTP.length));
            focusAt(index + 1);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Backspace') {
              event.preventDefault();
              if (value[index]) {
                commit(value.slice(0, index));
                focusAt(index);
              } else {
                commit(value.slice(0, Math.max(index - 1, 0)));
                focusAt(index - 1);
              }
            }
            if (event.key === 'ArrowLeft') focusAt(index - 1);
            if (event.key === 'ArrowRight') focusAt(index + 1);
          }}
          onPaste={(event) => {
            event.preventDefault();
            const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP.length);
            if (!pasted) return;
            commit(pasted);
            focusAt(pasted.length);
          }}
        />
      ))}
    </div>
  );
}

type Mode = 'otp' | 'password';

/**
 * P01 ログインフォーム（表4-11）。
 *
 * 1画面で2方式を切り替える:
 *   - 「ログインリンクを送信」= couple 向けのワンタイム認証（マジックリンク＋6桁コード。6-3-1）
 *   - 「パスワードでログイン」= planner／admin／system_admin 向け
 *
 * 送信要求はレート制限のため /api/auth/otp-request を経由する（4-3 P01）。
 * パスワード認証は表6-6 に無いので Supabase クライアント経由で行う（6-5 の原則）。
 * 連続失敗に対する制限は Supabase Auth 側の既定のレート制限に委ねる。
 */
export function LoginForm({ next }: { next: string | null }) {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>('otp');
  const [codeSent, setCodeSent] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [resendIn, setResendIn] = useState(0);

  const goToLanding = useCallback(
    (fallback: string) => {
      router.replace(next ?? fallback);
      router.refresh();
    },
    [next, router],
  );

  const handleFailure = (cause: unknown, fallbackMessage: string) => {
    if (cause instanceof ApiCallError) {
      setError(cause.message);
      setFieldErrors(cause.fieldErrors);
      return;
    }
    setError(fallbackMessage);
  };

  // 再送信の待ち時間（6-3-1 方針(3)／5-3 resendIntervalSeconds）
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setInterval(() => setResendIn((current) => Math.max(current - 1, 0)), 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  /**
   * メール本文のログインリンクを踏んで戻ってきた場合の着地処理。
   *
   * 認証要求元（このブラウザ）と着地先が同じブラウザならセッションを確立できる。
   * LINE内ブラウザ→既定ブラウザのように別ブラウザへ渡ると PKCE の検証値が引き継がれず失敗するため、
   * その場合は同一画面で完結する6桁コード入力へ誘導する（6-3-1 方針(1)）。
   */
  useEffect(() => {
    const url = new URL(window.location.href);
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    const authCode = url.searchParams.get('code');
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');
    const linkError = url.searchParams.get('error_description') ?? hashParams.get('error_description');

    if (!authCode && !accessToken && !linkError) return;

    // トークンを含むURLを履歴に残さない
    window.history.replaceState(null, '', url.pathname + (next ? `?next=${encodeURIComponent(next)}` : ''));

    if (linkError || (!authCode && !refreshToken)) {
      setError('ログインリンクが無効か、有効期限が切れています。メールに記載の6桁のコードをご入力ください');
      setCodeSent(true);
      return;
    }

    let cancelled = false;
    setPending(true);
    void (async () => {
      const supabase = createSupabaseBrowserClient();
      const result = authCode
        ? await supabase.auth.exchangeCodeForSession(authCode)
        : await supabase.auth.setSession({
            access_token: accessToken ?? '',
            refresh_token: refreshToken ?? '',
          });
      if (cancelled) return;
      setPending(false);
      if (result.error) {
        setError('このブラウザではログインリンクを確認できませんでした。メールに記載の6桁のコードをご入力ください');
        setCodeSent(true);
        return;
      }
      goToLanding('/');
    })();

    return () => {
      cancelled = true;
    };
    // 着地処理は初回マウント時に1度だけ行う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestOtp = async () => {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.post('/api/auth/otp-request', { email });
      setCodeSent(true);
      setCode('');
      setResendIn(OTP.resendIntervalSeconds);
      setNotice(
        `${email} 宛にログインリンクと6桁のコードをお送りしました。`
        + `どちらでもログインできます（有効期限は${Math.round(OTP.ttlSeconds / 60)}分）。`,
      );
    } catch (cause) {
      handleFailure(cause, 'メールを送信できませんでした。時間をおいてお試しください');
    } finally {
      setPending(false);
    }
  };

  const verifyOtp = async (submitted: string) => {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await api.post<{ redirectTo: string }>('/api/auth/otp-verify', {
        email,
        code: submitted,
      });
      goToLanding(result.redirectTo);
    } catch (cause) {
      handleFailure(cause, 'ログインできませんでした。時間をおいてお試しください');
      setPending(false);
    }
  };

  const signInWithPassword = async () => {
    setPending(true);
    setError(null);
    setFieldErrors({});
    const { error: signInError } = await createSupabaseBrowserClient().auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) {
      // 「登録が無い」と「パスワード違い」を区別せず返す（利用者列挙の防止。9章）
      setError('メールアドレスまたはパスワードが正しくありません');
      setPending(false);
      return;
    }
    // 遷移先はロールで決まる。ルートページが landingPathFor で振り分ける（4-2）
    goToLanding('/');
  };

  const switchMode = (nextMode: Mode) => {
    setMode(nextMode);
    setCodeSent(false);
    setCode('');
    setPassword('');
    setError(null);
    setNotice(null);
    setFieldErrors({});
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
          if (mode === 'password') return void signInWithPassword();
          if (!codeSent) return void requestOtp();
          return void verifyOtp(code);
        }}
      >
        <div>
          <label className="field-label" htmlFor="login-email">
            メールアドレス
          </label>
          <input
            id="login-email"
            className="field"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            disabled={pending || codeSent}
            placeholder="you@example.com"
            value={email}
            aria-invalid={fieldErrors.email ? true : undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
          <FieldError message={fieldErrors.email} />
        </div>

        {mode === 'password' && (
          <div>
            <label className="field-label" htmlFor="login-password">
              パスワード
            </label>
            <input
              id="login-password"
              className="field"
              type="password"
              autoComplete="current-password"
              required
              disabled={pending}
              value={password}
              aria-invalid={fieldErrors.password ? true : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldError message={fieldErrors.password} />
          </div>
        )}

        {mode === 'otp' && codeSent && (
          <div>
            <span className="field-label">ワンタイムコード（6桁）</span>
            <OtpInput
              value={code}
              onChange={setCode}
              onComplete={(completed) => void verifyOtp(completed)}
              disabled={pending}
              invalid={Boolean(fieldErrors.code)}
            />
            <FieldError message={fieldErrors.code} />
          </div>
        )}

        <button type="submit" className="btn-primary" disabled={pending}>
          {mode === 'password'
            ? 'パスワードでログイン'
            : codeSent
              ? '認証してログイン'
              : 'ログインリンクを送信'}
        </button>
      </form>

      {mode === 'otp' && codeSent && (
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            className="btn-ghost"
            disabled={pending || resendIn > 0}
            onClick={() => void requestOtp()}
          >
            {resendIn > 0 ? `コードを再送信（${resendIn}秒後）` : 'コードを再送信する'}
          </button>
          {/* 送信後はメール欄を固定するため、打ち間違いから戻れる導線を必ず残す */}
          <button
            type="button"
            className="btn-ghost"
            disabled={pending}
            onClick={() => switchMode('otp')}
          >
            メールアドレスを入力し直す
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="h-px flex-1 bg-border-light" />
        <span className="text-caption text-text-muted">または</span>
        <span className="h-px flex-1 bg-border-light" />
      </div>

      {mode === 'otp' ? (
        <button type="button" className="btn-secondary" onClick={() => switchMode('password')}>
          パスワードでログイン（プランナー・管理者）
        </button>
      ) : (
        <button type="button" className="btn-secondary" onClick={() => switchMode('otp')}>
          メールでログイン（新郎新婦）
        </button>
      )}

      <Link href="/password" className="btn-ghost self-center">
        パスワードをお忘れの方
      </Link>
    </div>
  );
}
