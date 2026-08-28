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
import { redirect } from 'next/navigation';

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

/**
 * セッションの解決結果。
 *
 *   anonymous … Auth セッションが無い（未ログイン）。API は 401、画面は /login へ
 *   inactive  … セッションはあるがプロフィールが active でない（停止・削除・初回設定前）。
 *               API は 403。current_app_user() が status='active' を必須とするため、
 *               この状態ではどのクエリも 0 行になる（6-3-4）
 *   active    … 通常
 */
export type ResolvedUser =
  | { state: 'anonymous' }
  | { state: 'inactive' }
  | { state: 'active'; user: AppUser };

/**
 * セッションを1回だけ解決する。
 *
 * auth.getUser() は JWT をサーバー側で検証するため GoTrue への HTTP 往復を伴う。
 * 以前は requireAppUser() が getUser() を呼んだあとに getAppUser() を呼び、
 * その getAppUser() の先頭でも同じ getUser() を呼んでいたため、
 * 401 と 403 を区別するためだけに全 Route Handler で往復が1回余計に走っていた。
 */
export async function resolveAppUser(): Promise<ResolvedUser> {
  const supabase = await createSupabaseServerClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return { state: 'anonymous' };

  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, auth_user_id, role, venue_id, display_name, email, status')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();

  if (error || !data || data.status !== 'active') return { state: 'inactive' };

  return {
    state: 'active',
    user: {
      id: data.id,
      authUserId: data.auth_user_id,
      role: data.role as Role,
      venueId: data.venue_id,
      displayName: data.display_name,
      email: data.email,
    },
  };
}

/** ログイン中の利用者を返す。未ログイン・非 active なら null。 */
export async function getAppUser(): Promise<AppUser | null> {
  const resolved = await resolveAppUser();
  return resolved.state === 'active' ? resolved.user : null;
}

/** API から呼ぶ。未ログインなら 401、非 active なら 403 を投げる。 */
export async function requireAppUser(): Promise<AppUser> {
  const resolved = await resolveAppUser();
  if (resolved.state === 'anonymous') throw unauthenticated();
  // Auth セッションはあるがプロフィールが active でない＝停止・削除・初回設定前
  if (resolved.state === 'inactive') {
    throw forbidden('アカウントが利用できない状態です。管理者にお問い合わせください');
  }
  return resolved.user;
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

/**
 * 画面（Server Component）から呼ぶ入口（4-2／4-3）。
 *
 * 未ログインは /login、権限が足りなければそのロールの着地点（4-2）へ送る。
 * 着地点が無い（couple が staff 画面を開いたなど）場合は P04 の 403 へ送る。
 *
 * (staff)/layout.tsx が「!user → /login」を守っているのに、
 * 配下の画面が同じ判定を書き直していたため、書き方が画面ごとに割れていた
 * （/error と /error?code=403 と landingPathFor が混在）。
 */
export async function requirePageUser(...roles: Role[]): Promise<AppUser> {
  const resolved = await resolveAppUser();
  // 非 active もログインし直してもらうしかないので /login へ送る。
  // 画面では 403 の説明よりログイン画面のほうが次の行動が明確（4-3）。
  if (resolved.state !== 'active') redirect('/login');

  const { user } = resolved;
  if (roles.length > 0 && !roles.includes(user.role)) {
    const landing = landingPathFor(user.role);
    // 自分の着地点が今いる画面と同じなら無限リダイレクトになるので P04 へ倒す
    redirect(landing === '/' ? '/error?code=403' : landing);
  }
  return user;
}
