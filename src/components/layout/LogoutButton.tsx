'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
/** 機能1-5 ログアウト。全画面ヘッダーから呼べるようにする（4-3）。 */
export function LogoutButton() {
  const router = useRouter();
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
        router.replace('/login');
        router.refresh();
      }}
    >
      ログアウト
    </button>
  );
}
