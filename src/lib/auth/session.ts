/**
 * セッションとロールの解決。
 *
 * 正本: 基本設計書 Version 1.2 6-3-1／6-3-4／13-1。
 *
 *   - current_app_user() は status='active' を必須条件とするため、
 *     invited／suspended／deleted の利用者はDB層で全拒否になる。
 *     API 層はこの状態を 403（FORBIDDEN）として扱い、再ログインを促す（6-3-4）。
 */
import { d1HomeCrumbFor } from '@/components/layout/breadcrumbItems';
import { isStaff, type Role } from '@/lib/constants';
import { forbidden, unauthenticated } from '@/lib/errors';
import { redirect } from 'next/navigation';
import { cache } from 'react';
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
  | {
      state: 'anonymous';
    }
  | {
      state: 'inactive';
    }
  | {
      state: 'active';
      user: AppUser;
    };
/** better-authのセッションとD1の有効プロフィールを要求単位で解決する。 */
// React.cacheは同じRSC requestのlayout/page間だけで共有し、次requestで破棄される。
// プロセス全体・Cookie値キーの共有キャッシュへ変更しない（別利用者への漏洩を防ぐ）。
export const resolveAppUser = cache(async (): Promise<ResolvedUser> => {
  {
    return (await import('@/lib/d1/auth')).resolveD1User();
  }
});
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
  const d1 = d1HomeCrumbFor(role);
  return d1?.href ?? '/mypage';
}
/** 着地点の画面名。エラー画面の「◯◯へ戻る」に使う。landingPathFor と対にする。 */
export function landingLabelFor(role: Role): string {
  const d1 = d1HomeCrumbFor(role);
  return d1?.label ?? 'マイページ';
}
/**
 * 画面（Server Component）から呼ぶ入口（4-2／4-3）。
 *
 * 未ログインは /login、権限が足りなければ P04（/error?code=403）へ送る。
 * 画面遷移図の「権限不足 → P04」に合わせる。以前は黙って着地点へ戻していたが、
 * 画面によってはエラー画面を出しており、扱いが割れていた（docs/ui-review/p2 低-8）。
 * P04 には着地点へ戻るボタンがあるので、行き止まりにはならない。
 *
 * (staff)/layout.tsx が「!user → /login」を守っているのに、
 * 配下の画面が同じ判定を書き直していたため、書き方が画面ごとに割れていた。
 * なお staff と couple の取り違え（新郎新婦がプランナー画面を開いた等）は、
 * ここに来る前に各 layout がそれぞれの着地点へ戻す。
 */
export async function requirePageUser(...roles: Role[]): Promise<AppUser> {
  const resolved = await resolveAppUser();
  // 非 active もログインし直してもらうしかないので /login へ送る。
  // 画面では 403 の説明よりログイン画面のほうが次の行動が明確（4-3）。
  if (resolved.state !== 'active') redirect('/login');
  const { user } = resolved;
  if (roles.length > 0 && !roles.includes(user.role)) {
    redirect('/error?code=403');
  }
  return user;
}
