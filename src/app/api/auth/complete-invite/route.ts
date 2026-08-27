/**
 * POST /api/auth/complete-invite — 初回パスワード設定の完了（invited → active）。
 *
 * 正本: 基本設計書 Version 1.2 6-3-1「認証方式」／表6-6。
 *   「初回パスワード設定によって Auth セッションが確立した本人の user_profiles 行のみを更新し、
 *     Service Role Key は使用しない（呼び出し元JWTの auth.uid() と一致する行に限定する）」
 *   この経路が無いと current_app_user() が0行を返し続け、恒久的にログインできない。
 *
 * 実装上の注意（20260828000700_auth_functions.sql に詳述）:
 *   RLS の user_profiles_update_self は WITH CHECK で current_app_user() との一致を要求するが、
 *   同関数は status='active' を必須条件とするため、更新前が 'invited' の行では0行を返し
 *   WITH CHECK が NULL となって成立しない。よって本人セッションからの直接 UPDATE は通らない。
 *   Service Role へ逃げると 6-3-5 表6-4 の使用範囲外になるため、
 *   「自分自身の invited → active だけ」に絞った security definer 関数 complete_invite() を呼ぶ。
 *   呼び出しは本人のセッション（authenticated）で行い、対象行は auth.uid() から関数内で解決する。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { forbidden, fromPostgresError, notFound, unauthenticated } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { completeInviteSchema } from '@/lib/validation';

type CompleteInviteResult = 'activated' | 'already_active' | 'not_allowed' | 'not_found';

export const POST = route(async (request) => {
  await parseBody(request, completeInviteSchema);

  const supabase = await createSupabaseServerClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw unauthenticated();

  const { data, error } = await supabase.rpc('complete_invite');
  if (error) throw fromPostgresError(error);

  const result = data as CompleteInviteResult;
  if (result === 'not_found') {
    throw notFound('利用者情報が見つかりません。管理者にお問い合わせください');
  }
  if (result === 'not_allowed') {
    // 停止・削除済み、または couple（パスワードを設定しないロール）からの呼び出し
    throw forbidden('このアカウントでは初回設定を完了できません。管理者にお問い合わせください');
  }

  // 二重呼び出し（already_active）は正常系として扱い、画面のリトライを妨げない。
  return ok({ status: result });
});
