'use client';
import { useState } from 'react';

import { api } from '@/lib/api/client';
import { navigateAfterSessionChange } from '@/lib/auth/navigate';
import { ROLE_LABEL, type Role } from '@/lib/constants';
import { publicDemoLogin } from '@/lib/d1/mode';

/** 本番と同じ4役割。表示順は権限の広い順。 */
const ROLES: readonly Role[] = ['system_admin', 'admin', 'planner', 'couple'];

function RoleSelect({ role, minimal }: { role: Role; minimal: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (next: Role) => {
    if (next === role || pending) return;
    setPending(true);
    setError(null);
    try {
      const { redirectTo } = await api.post<{ redirectTo: string }>('/api/auth/demo-login', {
        role: next,
      });
      navigateAfterSessionChange(redirectTo);
    } catch {
      setError('役割を切り替えられませんでした');
      setPending(false);
    }
  };
  return (
    <div className="no-print border-b border-border-light bg-field-filled-bg">
      <div
        className={`mx-auto flex items-center gap-2 py-1 text-caption text-text-secondary ${
          minimal ? 'max-w-phone px-screen' : 'w-full max-w-6xl px-4'
        }`}
      >
        <label htmlFor="demo-role-switcher" className="shrink-0 whitespace-nowrap">
          表示する役割
        </label>
        <select
          id="demo-role-switcher"
          className="min-h-[32px] min-w-0 rounded-field border border-border-mid bg-surface px-2 text-caption text-text-primary disabled:opacity-50"
          value={role}
          disabled={pending}
          onChange={(event) => void change(event.target.value as Role)}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <span className="shrink-0 text-text-muted">デモ</span>
        {error && (
          <span role="alert" className="min-w-0 text-danger">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/** npm run demo のときだけ出す、パスワード不要の役割切り替え。それ以外は何も描画しない。 */
export function DemoRoleSwitcher({ role, minimal = false }: { role: Role; minimal?: boolean }) {
  if (!publicDemoLogin()) return null;
  return <RoleSelect role={role} minimal={minimal} />;
}
