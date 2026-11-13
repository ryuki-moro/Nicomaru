'use client';
import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { api, ApiCallError } from '@/lib/api/client';
import { navigateAfterSessionChange } from '@/lib/auth/navigate';
import { OTP } from '@/lib/constants';
import { publicDemoLogin, publicLocalD1 } from '@/lib/d1/mode';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
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
 *   - 「確認コードを送信」= couple 向けのワンタイム認証（6桁コード。6-3-1）
 *   - 「パスワードでログイン」= planner／admin／system_admin 向け
 *
 * 送信要求はレート制限のため /api/auth/otp-request を経由する（4-3 P01）。
 * パスワード認証も /api/auth/password-login を経由する（Origin 検証と失敗の監査記録のため）。
 */
export function LoginForm({
  next,
  initialMode = 'otp',
  initialEmail = '',
}: {
  next: string | null;
  initialMode?: Mode;
  initialEmail?: string;
}) {
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
  // セッションが切り替わるので、クライアントルーターを使わずページ全体で遷移する（src/lib/auth/navigate.ts）
  const goToLanding = useCallback(
    (fallback: string) => navigateAfterSessionChange(next ?? fallback),
    [next],
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
        publicLocalD1()
          ? `${email} 宛の6桁の確認コードをローカル受信箱に保存しました（外部送信なし）。`
          : `${email} 宛に6桁の確認コードをお送りしました（有効期限は${Math.round(OTP.ttlSeconds / 60)}分）。`,
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
      const result = await api.post<{
        redirectTo: string;
      }>('/api/auth/otp-verify', {
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
      const result = await api.post<{
        redirectTo: string;
      }>('/api/auth/password-login', {
        email,
        password,
      });
      goToLanding(result.redirectTo);
    } catch (cause) {
      handleFailure(cause, 'ログインできませんでした。時間をおいてお試しください');
      setPending(false);
    }
  };
  // npm run demo: 入力を確かめず、方式に応じた役割でログインする
  const signInDemo = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await api.post<{
        redirectTo: string;
      }>('/api/auth/demo-login', {
        role: mode === 'password' ? 'planner' : 'couple',
      });
      goToLanding(result.redirectTo);
    } catch (cause) {
      handleFailure(cause, 'デモにログインできませんでした');
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
          if (publicDemoLogin()) return void signInDemo();
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
            required={!publicDemoLogin()}
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
              required={!publicDemoLogin()}
              disabled={pending}
              value={password}
              aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldError id="login-password-error" message={fieldErrors.password} />
            {/* 切り替えボタンの「プランナー・管理者」を、役割を選ぶボタンと読み違えないようにする */}
            <p className="mt-1 text-caption text-text-muted">
              ログイン後に使える画面は、入力したアカウントの権限で決まります。
            </p>
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
              : '確認コードを送信'}
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

        <Link href="/password" className="btn-ghost self-center">
          パスワードをお忘れの方
        </Link>
      </>
    </div>
  );
}
