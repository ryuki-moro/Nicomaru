'use client';
import { navigateAfterSessionChange } from '@/lib/auth/navigate';
import { useState } from 'react';
/** 機能1-5 ログアウト。全画面ヘッダーから呼べるようにする（4-3）。 */
export function LogoutButton() {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost min-h-[36px] px-3 py-1 text-caption"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        {
          const result = await fetch('/api/auth/sign-out', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          if (!result.ok) {
            setPending(false);
            return;
          }
        }
        // 古いセッションで描画した画面のキャッシュを残さないよう、ページ全体で遷移する（src/lib/auth/navigate.ts）
        navigateAfterSessionChange('/login');
      }}
    >
      ログアウト
    </button>
  );
}
