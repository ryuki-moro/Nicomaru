'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { createSupabaseBrowserClient } from '@/lib/supabase/client';

/** 機能1-5 ログアウト。全画面ヘッダーから呼べるようにする（4-3）。 */
export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      className="text-caption text-link hover:underline disabled:opacity-50"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await createSupabaseBrowserClient().auth.signOut();
        router.replace('/login');
        router.refresh();
      }}
    >
      ログアウト
    </button>
  );
}
