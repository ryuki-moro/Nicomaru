/**
 * 利用者一覧のサービス層（U01、機能7-1〜7-4）。
 *
 * 正本: 基本設計書 4-3 U01／表4-19、6-3-5 表6-4、付録A user_profiles_select。
 *
 * U01 が画面（Server Component）と GET /api/admin/users に二重実装されていた。
 * とくに `sanitizeKeyword`（PostgREST の or() 用エスケープ）がコメントごと同一で両方にあり、
 * 検索インジェクションの対策を直すときに、走らない側だけを直す事故が起こりうる形だった。
 */
import { type Role, type UserStatus } from '@/lib/constants';

/** U01／U02 が扱う利用者種別。couple は招待経由で作られるため対象外（表4-19）。 */
export const MANAGED_ROLES: readonly Role[] = ['planner', 'admin'];

/**
 * PostgREST の or() はカンマ・括弧で条件を区切るため、検索語をそのまま埋めると
 * 条件式を差し替えられる。値として意味を持つ記号を落としてから埋め込む。
 */
export function sanitizeKeyword(raw: string | undefined | null): string {
  return (raw ?? '')
    .replace(/[,()"\\*%]/g, ' ')
    .trim()
    .slice(0, 100);
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
