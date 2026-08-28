/**
 * /api/admin/users — 利用者の一覧取得（U01）と登録（U02）。
 *
 * 正本: 基本設計書 Version 1.2 表6-5／6-3-5 表6-4／4-3 表4-19／6-3-1。
 *
 * 【Service Role をどこで使うか】
 * 表6-4 の「/api/admin/users（Auth Admin API 利用）」に該当するのは
 * 他人の Auth ユーザーを作る generateLink だけ。user_profiles への書き込みは
 * RLS（user_profiles_admin_write）が権限昇格を塞げるため、通常のセッションで行う。
 * こうしておけば「admin が別式場に planner を作る」「admin が admin を作る」は
 * API 層のバグがあっても DB 層で落ちる（6-3-5 の最終防衛線）。
 *
 * 【利用者種別・所属式場を画面から受け取らない理由】
 * 表4-19 のとおり自動設定であり、任意指定を受け付けると権限昇格の入口になる。
 * role は admin→planner／system_admin→admin に固定し、venue_id は呼び出し元に固定する。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { ROLE_LABEL, type Role, type UserStatus } from '@/lib/constants';
import { ApiError, conflict, fromPostgresError, unprocessable } from '@/lib/errors';
import { issuePasswordSetupLink, sendPasswordSetupMail } from '@/lib/notify/mailer';
import { loadUserList } from '@/lib/services/users';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { userCreateSchema } from '@/lib/validation';

export const GET = route(async (request) => {
  const actor = await requireRole('admin', 'system_admin');
  const params = new URL(request.url).searchParams;

  const supabase = await createSupabaseServerClient();
  // 一覧の組み立ては U01 画面と同じサービス層を使う。
  // 検索語のエスケープが両方にあり、走らない側だけを直す事故が起こりうる形だった（#18）。
  const result = await loadUserList(supabase, {
    keyword: params.get('q'),
    page: Math.max(Number(params.get('page')) || 1, 1),
  });

  return ok({ users: result.rows, hasNext: result.hasNext, scope: actor.role });
});

export const POST = route(async (request) => {
  const actor = await requireRole('admin', 'system_admin');
  const input = await parseBody(request, userCreateSchema);

  // 表4-19 の自動設定規則。画面の入力ではなく呼び出し元のロールで決める
  const role: Role = actor.role === 'admin' ? 'planner' : 'admin';
  const venueId = actor.role === 'admin' ? actor.venueId : input.venueId ?? null;
  if (!venueId) {
    throw unprocessable('所属式場が特定できません', [
      { field: 'venueId', reason: '登録先の式場を指定してください' },
    ]);
  }

  const supabase = await createSupabaseServerClient();

  // Auth ユーザーを作る前に弾けるものは弾く。作ってから失敗すると後始末が要る
  const { data: duplicate, error: duplicateError } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('email', input.email)
    .maybeSingle();
  if (duplicateError) throw fromPostgresError(duplicateError);
  if (duplicate) throw conflict('このメールアドレスは既に登録されています');

  // 6-3-5 表6-4: 他人の Auth ユーザー操作にのみ Service Role を使う
  const admin = createSupabaseAdminClient('admin.users');
  const issued = await issuePasswordSetupLink(admin, { email: input.email });
  if (!issued.ok) {
    if (issued.reason === 'already_registered') {
      throw conflict('このメールアドレスは既に登録されています');
    }
    throw new ApiError('INTERNAL_ERROR', '初回パスワード設定リンクを発行できませんでした');
  }

  const { data: created, error } = await supabase
    .from('user_profiles')
    .insert({
      auth_user_id: issued.authUserId,
      venue_id: venueId,
      role,
      display_name: input.displayName,
      email: input.email,
      phone: input.phone ?? null,
      // 6-3-1: 初回パスワード設定が完了するまで invited。current_app_user() が0行を返しログインできない
      status: 'invited',
    })
    .select('id, display_name, email, role, status')
    .single();

  if (error) {
    // プロフィールが無いまま Auth ユーザーだけ残ると、そのメールでは二度と登録できなくなる
    await admin.auth.admin.deleteUser(issued.authUserId);
    throw fromPostgresError(error);
  }

  const createdRow = created as { id: string; display_name: string; email: string; role: Role; status: UserStatus };

  const { data: venue } = await supabase
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .maybeSingle();

  const mail = await sendPasswordSetupMail({
    to: input.email,
    displayName: input.displayName,
    roleLabel: ROLE_LABEL[role],
    venueName: (venue as { name: string } | null)?.name ?? null,
    actionLink: issued.actionLink,
  });

  // 監査ログは security definer 関数へ一本化されており、実行者は関数内で解決される（9-1）。
  // 暗号化対象・個人情報の値は入れない（表5-3 detail_json）
  const { error: auditError } = await supabase.rpc('log_audit', {
    p_action: 'user.create',
    p_target_type: 'user_profiles',
    p_target_id: createdRow.id,
    p_detail: { role, venue_id: venueId, mail_delivered: mail.delivered },
  });
  if (auditError) console.error('[api] 監査ログの記録に失敗しました', auditError);

  return ok(
    {
      user: {
        id: createdRow.id,
        displayName: createdRow.display_name,
        email: createdRow.email,
        role: createdRow.role,
        status: createdRow.status,
      },
      // 送れなかったことは画面に出す。管理者が U03 から再送できる（6-3-1）
      mailDelivered: mail.delivered,
    },
    201,
  );
});
