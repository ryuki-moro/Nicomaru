import type { SupabaseClient } from '@supabase/supabase-js';

export interface PerformanceFixtureIds {
  caseIds: string[];
  profileIds: string[];
  authUserIds: string[];
  venueIds: string[];
}

export interface CleanupFailure {
  step: 'cases' | 'audit_logs' | 'profiles' | 'auth' | 'venues' | 'browser';
  status: number | null;
  code: string;
}

/** 実行専用IDだけを削除する。UUID 300件の約12KBのURLによる414を防ぐ。 */
export async function cleanupPerformanceFixture(
  admin: SupabaseClient,
  ids: PerformanceFixtureIds,
): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  const clean = async (
    step: CleanupFailure['step'],
    query: PromiseLike<{ error: unknown; status?: number }>,
  ) => {
    try {
      const result = await query;
      if (!result.error) return;
      const error = result.error as { code?: unknown; status?: unknown };
      const status = result.status ?? error.status;
      failures.push({
        step,
        status: typeof status === 'number' ? status : null,
        code:
          typeof error.code === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(error.code)
            ? error.code
            : 'UNKNOWN',
      });
    } catch {
      failures.push({ step, status: null, code: 'TRANSPORT' });
    }
  };
  const deleteRows = async (
    table: string,
    column: string,
    values: string[],
    step: CleanupFailure['step'],
  ) => {
    for (let offset = 0; offset < values.length; offset += 50) {
      await clean(
        step,
        admin
          .from(table)
          .delete()
          .in(column, values.slice(offset, offset + 50)),
      );
    }
  };
  // 案件配下のCASCADEを先に完了する。担当者/カップルへのFKを残してAuthを消さない。
  await deleteRows('wedding_cases', 'id', ids.caseIds, 'cases');
  await deleteRows('audit_logs', 'actor_user_id', ids.profileIds, 'audit_logs');
  await deleteRows('user_profiles', 'id', ids.profileIds, 'profiles');
  for (const id of ids.authUserIds) await clean('auth', admin.auth.admin.deleteUser(id));
  await deleteRows('venues', 'id', ids.venueIds, 'venues');
  return failures;
}
