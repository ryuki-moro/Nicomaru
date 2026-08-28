/**
 * 利用者一覧のサービス層（U01、機能7-1〜7-4）。
 *
 * 正本: 基本設計書 4-3 U01／表4-19、6-3-5 表6-4、付録A user_profiles_select。
 *
 * U01 が画面（Server Component）と GET /api/admin/users に二重実装されていた。
 * とくに `sanitizeKeyword`（PostgREST の or() 用エスケープ）がコメントごと同一で両方にあり、
 * しかも画面は Supabase を直接叩くため API 側は実際には呼ばれていない。
 * 検索インジェクションの対策を直すときに、走らない側だけを直す事故が起こりうる形だった。
 */
import { LIST_PAGE_SIZE, type Role, type UserStatus } from '@/lib/constants';
import { fromPostgresError } from '@/lib/errors';
import type { SupabaseServerClient } from '@/lib/supabase/server';

/** U01／U02 が扱う利用者種別。couple は招待経由で作られるため対象外（表4-19）。 */
export const MANAGED_ROLES: readonly Role[] = ['planner', 'admin'];

/**
 * PostgREST の or() はカンマ・括弧で条件を区切るため、検索語をそのまま埋めると
 * 条件式を差し替えられる。値として意味を持つ記号を落としてから埋め込む。
 */
export function sanitizeKeyword(raw: string | undefined | null): string {
  return (raw ?? '').replace(/[,()"\\*%]/g, ' ').trim().slice(0, 100);
}

export interface UserProfileRow {
  id: string;
  display_name: string;
  email: string;
  phone: string | null;
  role: Role;
  venue_id: string | null;
  status: UserStatus;
  created_at: string;
}

export interface UserProfileListResult {
  rows: UserProfileRow[];
  hasNext: boolean;
}

/**
 * U01 一覧を引く。
 *
 * 範囲（admin は自式場、system_admin は全体）は user_profiles_select が決める。
 * ここでの絞り込みは表示上の都合であって権限の境界ではない。
 *
 * 1件多く取って次ページの有無を判定する。件数の追加問い合わせを避けるため。
 */
export async function loadUserList(
  supabase: SupabaseServerClient,
  options: { keyword?: string | null; page?: number; limit?: number } = {},
): Promise<UserProfileListResult> {
  const limit = options.limit ?? LIST_PAGE_SIZE;
  const page = Math.max(options.page ?? 1, 1);
  const from = (page - 1) * limit;
  const keyword = sanitizeKeyword(options.keyword);

  let query = supabase
    .from('user_profiles')
    .select('id, display_name, email, phone, role, venue_id, status, created_at')
    .in('role', MANAGED_ROLES)
    .order('role')
    .order('display_name')
    .order('id')
    .range(from, from + limit);

  if (keyword) {
    query = query.or(`display_name.ilike.*${keyword}*,email.ilike.*${keyword}*`);
  }

  const { data, error } = await query;
  if (error) throw fromPostgresError(error);

  const fetched = (data ?? []) as unknown as UserProfileRow[];
  return { rows: fetched.slice(0, limit), hasNext: fetched.length > limit };
}
