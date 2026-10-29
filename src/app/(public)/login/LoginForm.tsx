'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { startTransition, useCallback, useEffect, useRef, useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { api, ApiCallError } from '@/lib/api/client';
import { hasLoginLinkFragment, LOGIN_LINK_PATH } from '@/lib/auth/login-link';
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
  describedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
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
          aria-describedby={describedBy}
          className={[
            'h-11 w-9 rounded-field bg-surface text-center text-base text-text-primary',
            'focus:border-2 focus:border-primary focus:outline-hidden',
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
            const pasted = event.clipboardData
              .getData('text')
              .replace(/\D/g, '')
              .slice(0, OTP.length);
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
 * パスワード認証も /api/auth/password-login を経由する（Origin 検証と失敗の監査記録のため）。
 * 連続失敗はアプリ側の回数制限（RATE_LIMITS.password_login）と Supabase Auth の既定の制限で抑える。
 */
export function LoginForm({
  next,
  initialMode = 'otp',
  initialEmail = '',
}: {
  next: string | null;
  initialMode?: Mode;
  /** メールのリンクの着地（/login/link）で読み取ったアドレス。再送するときに入れ直させない */
  initialEmail?: string;
}) {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [codeSent, setCodeSent] = useState(false);
  // 送信後はメール欄を固定する。ただし旧形式のリンクで着地に失敗したときは
  // 送信要求をしていない（どのアドレス宛てか画面が知らない）ので、入力できるままにする
  const [emailEditable, setEmailEditable] = useState(false);
  const [email, setEmail] = useState(initialEmail);
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
    const timer = window.setInterval(
      () => setResendIn((current) => Math.max(current - 1, 0)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [resendIn]);

  /**
   * メール本文のログインリンクを踏んで戻ってきた場合の着地処理。
   *
   * 現行のメールのリンクは専用の着地画面（/login/link#e=…&c=…）へ行く。
   * Supabase が戻り先を Site URL に置き換えた場合（ホスト名の不一致）は、
   * フラグメントを持ったままここへ着くので、着地画面へ送り直す。
   *
   * 以下は移行期間に届いている旧形式のメール（?code=、PKCE）の着地処理。
   * 認証要求元（このブラウザ）と着地先が同じブラウザならセッションを確立できる。
   * LINE内ブラウザ→既定ブラウザのように別ブラウザへ渡ると PKCE の検証値が引き継がれず失敗するため、
   * その場合は同一画面で完結する「メールアドレス＋6桁コード」の入力へ誘導する（6-3-1 方針(1)）。
   */
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_NICOMARU_DB === 'd1-local') return;
    const url = new URL(window.location.href);
    if (hasLoginLinkFragment(url.hash)) {
      window.location.replace(
        `${LOGIN_LINK_PATH}${next ? `?next=${encodeURIComponent(next)}` : ''}${url.hash}`,
      );
      return;
    }
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    const authCode = url.searchParams.get('code');
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');
    const linkError =
      url.searchParams.get('error_description') ?? hashParams.get('error_description');

    if (!authCode && !accessToken && !linkError) return;

    // トークンを含むURLを履歴に残さない
    window.history.replaceState(
      null,
      '',
      url.pathname + (next ? `?next=${encodeURIComponent(next)}` : ''),
    );

    // 失敗時はメール欄も入力できる状態でコード入力を出す（メール欄が空のまま固定される行き止まりにしない）
    if (linkError || (!authCode && !refreshToken)) {
      startTransition(() => {
        setError(
          'ログインリンクが無効か、有効期限が切れています。メールアドレスとメールに記載の6桁のコードをご入力ください',
        );
        setCodeSent(true);
        setEmailEditable(true);
      });
      return;
    }

    let cancelled = false;
    startTransition(() => setPending(true));
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
        setError(
          'このブラウザではログインリンクを確認できませんでした。メールアドレスとメールに記載の6桁のコードをご入力ください',
        );
        setCodeSent(true);
        setEmailEditable(true);
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
      // 戻り先をメールのリンクにも載せる（4-2）。サーバー側で同じ規則で検証し直す
      await api.post('/api/auth/otp-request', { email, next: next ?? undefined });
      setCodeSent(true);
      setEmailEditable(false);
      setCode('');
      setResendIn(OTP.resendIntervalSeconds);
      setNotice(
        process.env.NEXT_PUBLIC_NICOMARU_DB === 'd1-local'
          ? `${email} 宛の6桁の確認コードをローカル受信箱に保存しました（外部送信なし）。`
          : `${email} 宛にログインリンクと6桁のコードをお送りしました。` +
              `どちらでもログインできます（有効期限は${Math.round(OTP.ttlSeconds / 60)}分）。`,
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
    try {
      const result = await api.post<{ redirectTo: string }>('/api/auth/password-login', {
        email,
        password,
      });
      goToLanding(result.redirectTo);
    } catch (cause) {
      handleFailure(cause, 'ログインできませんでした。時間をおいてお試しください');
      setPending(false);
    }
  };

  const switchMode = (nextMode: Mode) => {
    setMode(nextMode);
    setCodeSent(false);
    setEmailEditable(false);
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
            disabled={pending || (codeSent && !emailEditable)}
            placeholder="you@example.com"
            value={email}
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? 'login-email-error' : undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
          <FieldError id="login-email-error" message={fieldErrors.email} />
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
              aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldError id="login-password-error" message={fieldErrors.password} />
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
              describedBy={fieldErrors.code ? 'login-code-error' : undefined}
            />
            <FieldError id="login-code-error" message={fieldErrors.code} />
          </div>
        )}

        <button type="submit" className="btn-primary" disabled={pending}>
          {mode === 'password'
            ? 'パスワードでログイン'
            : codeSent
              ? '認証してログイン'
              : process.env.NEXT_PUBLIC_NICOMARU_DB === 'd1-local'
                ? '確認コードを送信'
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

      <>
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

        {process.env.NEXT_PUBLIC_NICOMARU_DB !== 'd1-local' && (
          <Link href="/password" className="btn-ghost self-center">
            パスワードをお忘れの方
          </Link>
        )}
      </>
    </div>
  );
}
