'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { api, ApiCallError } from '@/lib/api/client';

export function DevAdminLoginButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="card flex flex-col gap-3">
      <p className="text-label text-text-muted">
        開発用の式場管理者として、入力を省略してログインできます。
      </p>
      <ErrorSummary message={error} />
      <button
        type="button"
        className="btn-secondary"
        disabled={pending}
        onClick={async () => {
          if (pending) return;
          setPending(true);
          setError(null);
          try {
            const result = await api.post<{ redirectTo: string }>('/api/auth/dev-admin');
            router.replace(result.redirectTo);
            router.refresh();
          } catch (cause) {
            setError(
              cause instanceof ApiCallError
                ? cause.message
                : '開発用adminでログインできませんでした',
            );
            setPending(false);
          }
        }}
      >
        {pending ? 'ログインしています…' : '開発用adminで入る'}
      </button>
    </div>
  );
}
