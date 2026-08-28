/**
 * セッションとロールの解決。
 *
 * 正本: 基本設計書 Version 1.2 6-3-1／6-3-4／13-1。
 *
 *   - 認証確認は Supabase Auth のセッション（JWT）を検証し、その後の権限範囲は RLS に委譲する（6-5）。
 *   - current_app_user() は status='active' を必須条件とするため、
 *     invited／suspended／deleted の利用者はDB層で全拒否になる。
 *     API 層はこの状態を 403（FORBIDDEN）として扱い、再ログインを促す（6-3-4）。
 */
import { isStaff, type Role } from '@/lib/constants';
import { forbidden, unauthenticated } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface AppUser {
  /** user_profiles.id（アプリ側の利用者ID） */
  id: string;
  authUserId: string;
  role: Role;
  venueId: string | null;
  displayName: string;
  email: string;
}

/** ログイン中の利用者を返す。未ログイン・非 active なら null。 */
export async function getAppUser(): Promise<AppUser | null> {
  const supabase = await createSupabaseServerClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return null;

  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, auth_user_id, role, venue_id, display_name, email, status')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();

  if (error || !data || data.status !== 'active') return null;

  return {
    id: data.id,
    authUserId: data.auth_user_id,
    role: data.role as Role,
    venueId: data.venue_id,
    displayName: data.display_name,
    email: data.email,
  };
}

/** API から呼ぶ。未ログインなら 401、非 active なら 403 を投げる。 */
export async function requireAppUser(): Promise<AppUser> {
  const supabase = await createSupabaseServerClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw unauthenticated();

  const user = await getAppUser();
  // Auth セッションはあるがプロフィールが active でない＝停止・削除・初回設定前
  if (!user) throw forbidden('アカウントが利用できない状態です。管理者にお問い合わせください');
  return user;
}

/** planner／admin／system_admin のみに許可する API で使う。 */
export async function requireStaff(): Promise<AppUser> {
  const user = await requireAppUser();
  if (!isStaff(user.role)) throw forbidden();
  return user;
}

export async function requireRole(...roles: Role[]): Promise<AppUser> {
  const user = await requireAppUser();
  if (!roles.includes(user.role)) throw forbidden();
  return user;
}

/** ログイン後の遷移先（4-2）。 */
export function landingPathFor(role: Role): string {
  switch (role) {
    case 'couple':
      return '/mypage';
    case 'planner':
    case 'admin':
      return '/dashboard';
    case 'system_admin':
      // 4-2: system_admin の初期遷移先は S03。
      // Phase 1 では S01〜S03 が未実装だったため U01 へ寄せていた（4-2 の但し書き）。
      return '/system';
  }
}
