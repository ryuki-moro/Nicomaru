'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { api, ApiCallError } from '@/lib/api/client';
import { readLoginLinkFragment } from '@/lib/auth/login-link';

import { LoginForm } from '../LoginForm';

type State =
  | { kind: 'reading' }
  | { kind: 'ready'; email: string; code: string }
  | { kind: 'failed'; email: string | null; message: string };

const RETRY_GUIDE = '最新のメールのリンクをお使いいただくか、コードを送り直してください。';

/**
 * メールのログインリンクの着地（/login/link#e=…&c=…）。
 *
 * 正本: 基本設計書 Version 1.2 6-3-1 方針(1)。読み取り・検証の規則は src/lib/auth/login-link.ts。
 *
 * 開いただけではログインしない。「〇〇 でログインします」と見せてからボタンで検証する。
 *   - メールのセキュリティスキャナや先読みが開いても、コードを消費しない
 *   - 他人のリンクを踏まされたとき（ログイン CSRF）、誰としてログインするかが押す前に分かる
 *   - 共用端末で別の人がログイン中なら、切り替わることを添える（黙って元のアカウントのまま進ませない）
 * 検証はコード入力と同じ POST /api/auth/otp-verify（レート制限・失敗回数・監査も同じ経路を通る）。
 */
export function LoginLinkForm({
  next,
  currentEmail,
}: {
  next: string | null;
  /** この端末で既にログインしている利用者のメールアドレス */
  currentEmail: string | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'reading' });
  const [pending, setPending] = useState(false);
  const fragmentRead = useRef(false);

  // フラグメントはサーバーへ届かないので、マウント後に読む。
  // 読んだらすぐ URL から消し、履歴・共有・画面録画にメールアドレスとコードを残さない（LoginForm と同じ流儀）。
  // 消した後に読み直すと「読み取れない」になるので、1回だけ読む（開発時の StrictMode は effect を2回呼ぶ）。
  useEffect(() => {
    if (fragmentRead.current) return;
    fragmentRead.current = true;
    const { pathname, search, hash } = window.location;
    const { email, code } = readLoginLinkFragment(hash);
    if (hash) window.history.replaceState(null, '', pathname + search);

    setState(
      email && code
        ? { kind: 'ready', email, code }
        : {
            kind: 'failed',
            email,
            message: `ログインリンクの内容を読み取れませんでした。${RETRY_GUIDE}`,
          },
    );
  }, []);

  const login = async (email: string, code: string) => {
    setPending(true);
    try {
      const result = await api.post<{ redirectTo: string }>('/api/auth/otp-verify', {
        email,
        code,
      });
      router.replace(next ?? result.redirectTo);
      router.refresh();
    } catch (cause) {
      const reason =
        cause instanceof ApiCallError
          ? cause.message
          : 'ログインできませんでした。時間をおいてお試しください';
      setState({ kind: 'failed', email, message: `${reason}。${RETRY_GUIDE}` });
      setPending(false);
    }
  };

  if (state.kind === 'reading') {
    return (
      <div className="card" role="status">
        <span className="text-label text-text-muted">ログインリンクを確認しています…</span>
      </div>
    );
  }

  if (state.kind === 'failed') {
    // 読み取ったアドレスを入れた状態で、その場でコードを送り直せるようにする（行き止まりにしない）
    return (
      <div className="flex flex-col gap-3">
        <ErrorSummary message={state.message} />
        <LoginForm next={next} initialEmail={state.email ?? ''} />
      </div>
    );
  }

  const switching = currentEmail !== null && currentEmail !== state.email;

  return (
    <div className="card flex flex-col gap-4">
      {switching && (
        <div role="status" className="banner-info">
          <span>
            現在 {currentEmail} でログイン中です。{state.email} に切り替えます。
          </span>
        </div>
      )}

      <p className="text-body text-text-primary">
        <strong className="break-all">{state.email}</strong> でログインします。
      </p>

      <button
        type="button"
        className="btn-primary"
        disabled={pending}
        onClick={() => void login(state.email, state.code)}
      >
        ログインする
      </button>

      <p className="text-caption text-text-muted">
        心当たりのないメールアドレスが表示されている場合は、ログインせずにこの画面を閉じてください。
      </p>
    </div>
  );
}
