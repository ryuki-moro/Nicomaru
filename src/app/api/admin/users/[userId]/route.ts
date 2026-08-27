/**
 * /api/admin/users/{userId} — 利用者の変更（U03）と論理削除（U04）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-20／U04 の記述／6-3-1／6-3-5 表6-4／13-1。
 *
 * 【Service Role の範囲】
 * 表6-4 に沿い、他人の Auth ユーザーに触れる操作（メール同期・停止・無効化・
 * 設定リンクの再発行）だけを Service Role で行う。user_profiles／wedding_cases の
 * 更新は RLS 経由にして、権限の境界を DB 層に残す。
 *
 * 【セッション失効の考え方（13-1）】
 * Auth 側の ban はリフレッシュを止めるが、発行済みアクセストークンは最長1時間残る。
 * 実際の遮断は RLS 共通関数 current_app_user() が status='active' を必須とすることで
 * 即座に効く。したがって ban の失敗は致命傷ではなく、記録して処理を続ける。
 */
import { noContent, ok, parseBody, route } from '@/lib/api/route';
import { requireRole, type AppUser } from '@/lib/auth/session';
import { ROLE_LABEL, type Role, type UserStatus } from '@/lib/constants';
import { ApiError, conflict, forbidden, fromPostgresError, notFound, unprocessable } from '@/lib/errors';
import { issuePasswordSetupLink, sendPasswordSetupMail } from '@/lib/notify/mailer';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { userDeleteSchema, userUpdateWithActionSchema } from '@/lib/validation';

type RouteContext = { params: Promise<{ userId: string }> };
type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/** 実質的な無期限。Supabase の ban_duration は期間指定しか受け付けない。 */
const BAN_DURATION = '876000h';

interface ManagedUser {
  id: string;
  auth_user_id: string;
  venue_id: string | null;
  role: Role;
  display_name: string;
  email: string;
  phone: string | null;
  status: UserStatus;
}

/**
 * 対象利用者を取得し、呼び出し元が管理してよい相手かを確かめる。
 * 範囲は U02 の自動設定規則（admin→planner／system_admin→admin）の裏返しで、
 * admin が別式場や admin を触れないようにする。RLS も同じ境界を持つ二重化（6-3-5）。
 */
async function loadManagedUser(
  supabase: ServerClient,
  actor: AppUser,
  userId: string,
): Promise<ManagedUser> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, auth_user_id, venue_id, role, display_name, email, phone, status')
    .eq('id', userId)
    .maybeSingle();
  // 22P02 = UUID として解釈できない値。存在しない対象と同じ扱いにする
  if (error) throw error.code === '22P02' ? notFound() : fromPostgresError(error);
  if (!data) throw notFound();

  const target = data as ManagedUser;
  const manageable = actor.role === 'admin'
    ? target.role === 'planner' && target.venue_id === actor.venueId
    : target.role === 'planner' || target.role === 'admin';
  if (!manageable) throw forbidden();

  return target;
}

/**
 * 監査ログ（9-1）。書き込みは security definer 関数へ一本化されており、
 * 実行者は関数内で auth.uid() から解決されるため偽装できない。
 * 応答前に await する（サーバーレスでは応答後の非同期処理が凍結されうるため）。
 * 失敗しても業務操作は巻き戻さず、記録だけを残す。
 */
async function writeAudit(
  supabase: ServerClient,
  action: string,
  targetId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.rpc('log_audit', {
    p_action: action,
    p_target_type: 'user_profiles',
    p_target_id: targetId,
    p_detail: detail,
  });
  if (error) console.error('[api] 監査ログの記録に失敗しました', error);
}

/** 式場名はメール本文の宛名にだけ使う。system_admin は venue_id を持たない（5-3）。 */
async function venueNameOf(supabase: ServerClient, venueId: string | null): Promise<string | null> {
  if (!venueId) return null;
  const { data } = await supabase.from('venues').select('name').eq('id', venueId).maybeSingle();
  return (data as { name: string } | null)?.name ?? null;
}

export const PATCH = route<[RouteContext]>(async (request, context) => {
  const actor = await requireRole('admin', 'system_admin');
  const { userId } = await context.params;
  const input = await parseBody(request, userUpdateWithActionSchema);

  const supabase = await createSupabaseServerClient();
  const target = await loadManagedUser(supabase, actor, userId);

  // 再送の可否は書き込み前に判定する。途中まで反映してから 422 を返すと状態が読めなくなる
  if (input.resendInviteLink && (input.status ?? target.status) !== 'invited') {
    throw unprocessable('初回パスワード設定リンクを再送できるのは、まだ設定が済んでいない利用者だけです');
  }

  const patch: Record<string, unknown> = {};
  if (input.displayName !== undefined) patch.display_name = input.displayName;
  if (input.phone !== undefined) patch.phone = input.phone ?? null;
  if (input.email !== undefined && input.email !== target.email) patch.email = input.email;
  if (input.status !== undefined && input.status !== target.status) patch.status = input.status;

  const nextEmail = patch.email as string | undefined;
  const nextStatus = patch.status as UserStatus | undefined;

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from('user_profiles').update(patch).eq('id', target.id);
    if (error) {
      if (error.code === '23505') throw conflict('このメールアドレスは既に登録されています');
      throw fromPostgresError(error);
    }
  }

  const needsAuthAdmin = nextEmail !== undefined || nextStatus !== undefined
    || input.resendInviteLink === true;
  const admin = needsAuthAdmin ? createSupabaseAdminClient('admin.users') : null;

  if (admin && nextEmail !== undefined) {
    // 表4-20:「変更時は Supabase Auth 側のメールも同期する」
    const { error } = await admin.auth.admin.updateUserById(target.auth_user_id, { email: nextEmail });
    if (error) {
      // 片側だけ変わるとログインできないアカウントになるため、DB を元へ戻す
      await supabase.from('user_profiles').update({ email: target.email }).eq('id', target.id);
      throw conflict('このメールアドレスは利用できません。別のアドレスを指定してください');
    }
  }

  if (admin && nextStatus !== undefined) {
    const { error } = await admin.auth.admin.updateUserById(target.auth_user_id, {
      ban_duration: nextStatus === 'suspended' ? BAN_DURATION : 'none',
    });
    if (error) console.error('[api] Auth ユーザーの停止状態を更新できませんでした', error);
  }

  let mailDelivered: boolean | null = null;
  if (admin && input.resendInviteLink) {
    const email = nextEmail ?? target.email;
    const issued = await issuePasswordSetupLink(admin, { email, isResend: true });
    if (!issued.ok) {
      throw new ApiError('INTERNAL_ERROR', '初回パスワード設定リンクを発行できませんでした');
    }
    const mail = await sendPasswordSetupMail({
      to: email,
      displayName: input.displayName ?? target.display_name,
      roleLabel: ROLE_LABEL[target.role],
      venueName: await venueNameOf(supabase, target.venue_id),
      actionLink: issued.actionLink,
      isResend: true,
    });
    mailDelivered = mail.delivered;
  }

  await writeAudit(supabase, 'user.update', target.id, {
    changed: Object.keys(patch),
    status: nextStatus ?? target.status,
    invite_resent: input.resendInviteLink === true,
  });

  return ok({ id: target.id, status: nextStatus ?? target.status, mailDelivered });
});

export const DELETE = route<[RouteContext]>(async (request, context) => {
  const actor = await requireRole('admin', 'system_admin');
  const { userId } = await context.params;
  const input = await parseBody(request, userDeleteSchema);

  // U04:「ログイン中の自身は削除不可」
  if (userId === actor.id) {
    throw unprocessable('ログイン中のご自身のアカウントは削除できません');
  }

  const supabase = await createSupabaseServerClient();
  const target = await loadManagedUser(supabase, actor, userId);
  if (target.status === 'deleted') return noContent();

  let handedOverCases = 0;

  if (target.role === 'planner') {
    const { count, error } = await supabase
      .from('wedding_cases')
      .select('id', { count: 'exact', head: true })
      .eq('primary_planner_id', target.id);
    if (error) throw fromPostgresError(error);

    if ((count ?? 0) > 0) {
      // U04:「担当案件が存在する planner は引き継ぎ先の指定を必須とし、未指定なら削除できない」
      if (!input.successorPlannerId) {
        throw unprocessable('担当している案件があるため、引き継ぎ先のプランナーが必要です', [
          { field: 'successorPlannerId', reason: '引き継ぎ先のプランナーを選んでください' },
        ]);
      }

      const { data: successorData, error: successorError } = await supabase
        .from('user_profiles')
        .select('id, role, status, venue_id')
        .eq('id', input.successorPlannerId)
        .maybeSingle();
      if (successorError) throw fromPostgresError(successorError);

      const successor = successorData as Pick<ManagedUser, 'id' | 'role' | 'status' | 'venue_id'> | null;
      const usable = successor
        && successor.id !== target.id
        && successor.role === 'planner'
        && successor.status === 'active'
        && successor.venue_id === target.venue_id;
      if (!usable) {
        throw unprocessable('引き継ぎ先に指定できない利用者です', [
          { field: 'successorPlannerId', reason: '同じ式場の利用中プランナーを選んでください' },
        ]);
      }

      const { error: moveError } = await supabase
        .from('wedding_cases')
        .update({ primary_planner_id: successor.id })
        .eq('primary_planner_id', target.id);
      if (moveError) throw fromPostgresError(moveError);
      handedOverCases = count ?? 0;
    }
  }

  // 5-1 削除方針: 物理削除せず status で論理削除する
  const { error: deleteError } = await supabase
    .from('user_profiles')
    .update({ status: 'deleted' })
    .eq('id', target.id);
  if (deleteError) throw fromPostgresError(deleteError);

  const admin = createSupabaseAdminClient('admin.users');
  const { error: banError } = await admin.auth.admin.updateUserById(target.auth_user_id, {
    ban_duration: BAN_DURATION,
  });
  if (banError) console.error('[api] Auth ユーザーを無効化できませんでした', banError);

  await writeAudit(supabase, 'user.delete', target.id, {
    role: target.role,
    venue_id: target.venue_id,
    handed_over_cases: handedOverCases,
  });

  return noContent();
});
