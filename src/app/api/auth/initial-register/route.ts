/**
 * POST /api/auth/initial-register — 招待URLからの初回登録（P02 / 機能1-2）。
 *
 * 正本: 基本設計書 Version 1.2 6-6-1「初回登録フロー」／6-3-5 表6-4／13-1。
 *
 * 未ログイン状態で case_invitations を照合する必要があるため Service Role を使う。
 * RLS をバイパスする代わりに、表6-4 が要求する検証をすべて本ハンドラで明示的に行う:
 *   (1) token_hash 照合と expires_at／used_at／revoked_at／purpose／max_uses チェックを
 *       単一の UPDATE ... RETURNING（consume_invitation）で原子的に実施する。
 *   (2) recipient_email が設定された招待は入力メールとの一致を必須とする。
 *       recipient_email が NULL（LINE案内）の招待は、確認コード検証まで案件へ紐付けない。
 *   (3) Auth ユーザー → user_profiles → 既存 couple_profiles への紐付け、の順に確定する。
 *   (4) 途中失敗時は補償処理で巻き戻す。自動リトライはしない。
 *   (5) communication_logs に source='initial_register' で自動記録する。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { landingPathFor } from '@/lib/auth/session';
import { COUPLE_PROFILE_COLUMNS } from '@/lib/constants';
import { emailHash, encryptPii, normalizeEmail } from '@/lib/crypto';
import { conflict, fromPostgresError, notFound, unprocessable } from '@/lib/errors';
import { hashInvitationToken, matchRecipientEmail } from '@/lib/services/invitations';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient, type SupabaseServerClient } from '@/lib/supabase/server';
import { initialRegisterSchema } from '@/lib/validation';

import { enforceAuthRateLimit } from '../shared';

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** consume_invitation() の戻り（20260828000700_auth_functions.sql）。 */
interface ConsumedInvitation {
  id: string;
  case_id: string;
  target_partner_role: string;
  recipient_email_hash: string | null;
}

interface CaseRow {
  id: string;
  venue_id: string;
}

interface UserProfileRow {
  id: string;
  auth_user_id: string;
  role: string;
  status: string;
}

interface CoupleProfileRow {
  id: string;
  user_profile_id: string | null;
  email: string | null;
  email_hash: string | null;
}

/**
 * 「登録完了と同時にワンタイム認証でセッションを確立する」（6-6-1）を、
 * 画面に再度コード入力をさせずに満たす。
 * Admin API で magiclink を生成し（この呼び出しではメールは送信されない）、
 * 得た token_hash を本人セッション用クライアントで検証して Cookie を発行する。
 */
async function establishSession(
  admin: AdminClient,
  userClient: SupabaseServerClient,
  email: string,
): Promise<boolean> {
  try {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const tokenHash = data?.properties?.hashed_token;
    if (error || !tokenHash) return false;

    const { error: verifyError } = await userClient.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'magiclink',
    });
    return !verifyError;
  } catch (error) {
    // ここで失敗しても登録自体は成立している。画面側でワンタイムコード入力へ切り替える。
    console.error('[auth] initial-register: session establishment failed', error);
    return false;
  }
}

export const POST = route(async (request) => {
  const body = await parseBody(request, initialRegisterSchema);
  await enforceAuthRateLimit(request, 'initial_register', body.email);

  const email = normalizeEmail(body.email);
  const inputEmailHash = emailHash(email);

  // LINE案内の招待で「確認コードを検証済みか」を判定する材料（6-6-1）。
  // 入力メールと同じアドレスで Auth セッションが確立していることを本人確認の成立とみなす。
  const userClient = await createSupabaseServerClient();
  const { data: authData } = await userClient.auth.getUser();
  const emailVerified = !!authData.user?.email && normalizeEmail(authData.user.email) === email;

  const admin = createSupabaseAdminClient('auth.initial-register');

  // (1) 検証と消費を単一の UPDATE ... RETURNING で原子的に行う。
  //     同一URLの同時2リクエストでも1つしか通らない（6-6-1）。
  const { data: consumedRows, error: consumeError } = await admin.rpc('consume_invitation', {
    p_token_hash: hashInvitationToken(body.token),
    p_purpose: 'initial_registration',
  });
  if (consumeError) throw fromPostgresError(consumeError);

  const invitation = (consumedRows as ConsumedInvitation[] | null)?.[0];
  if (!invitation) {
    // 期限切れ・使用済み・失効・用途違いを区別せず 422（6-5-1）。K02 から再発行できる。
    throw unprocessable(
      'この招待URLは使用済みか、有効期限が切れています。プランナーへ再発行をご依頼ください',
    );
  }

  // 補償処理で戻すために「このリクエストで作ったもの」だけを覚えておく。
  let createdAuthUserId: string | null = null;
  let createdProfileId: string | null = null;
  let linkedCoupleProfile: { id: string; email: string | null; emailHash: string | null } | null =
    null;

  const restoreInvitation = async () => {
    const { error } = await admin.rpc('restore_invitation', { p_invitation_id: invitation.id });
    if (error) console.error('[auth] restore_invitation failed', { code: error.code });
  };

  /**
   * (4) 補償処理。外部キーの向き（couple_profiles → user_profiles → auth.users）と逆順に戻す。
   *
   * 消費したトークンも必ず戻す。メールの打ち間違い（422 mismatch）で招待が使えなくなると
   * プランナーの再発行が必須になり、運用負荷が入力ミスの数だけ増えるため。
   * 二重登録の防止は「消費 → 成功まで戻さない」ではなく
   * couple_profiles.user_profile_id の UNIQUE と .is('user_profile_id', null) が担保する。
   */
  const compensate = async () => {
    try {
      if (linkedCoupleProfile) {
        await admin
          .from('couple_profiles')
          .update({
            user_profile_id: null,
            email: linkedCoupleProfile.email,
            email_hash: linkedCoupleProfile.emailHash,
          })
          .eq('id', linkedCoupleProfile.id);
      }
      if (createdProfileId) {
        await admin.from('user_profiles').delete().eq('id', createdProfileId);
      }
      if (createdAuthUserId) {
        await admin.auth.admin.deleteUser(createdAuthUserId);
      }
      await restoreInvitation();
    } catch (error) {
      // 補償の失敗までは画面に出さない。運用で検知するためサーバーログに残す（10章）。
      console.error('[auth] initial-register: compensation failed', error);
    }
  };

  let verificationRequired = false;

  try {
    // (2) 招待先メールとの照合（6-6-1／13-1）
    const match = matchRecipientEmail(invitation.recipient_email_hash, inputEmailHash);
    if (match === 'mismatch') {
      throw unprocessable('招待をお送りしたメールアドレスと一致しません', [
        { field: 'email', reason: '招待をお受け取りになったメールアドレスをご入力ください' },
      ]);
    }

    // user_profiles.venue_id は role<>'system_admin' で NOT NULL 相当のため、案件から解決する。
    const { data: caseData, error: caseError } = await admin
      .from('wedding_cases')
      .select('id, venue_id')
      .eq('id', invitation.case_id)
      .maybeSingle();
    if (caseError) throw fromPostgresError(caseError);
    const caseRow = caseData as CaseRow | null;
    if (!caseRow) throw notFound('招待に対応する案件が見つかりません');

    // (3) Auth ユーザーと user_profiles。既にあれば作り直さない（確認コード検証後の再送信で通る経路）。
    const { data: profileData, error: profileLookupError } = await admin
      .from('user_profiles')
      .select('id, auth_user_id, role, status')
      .eq('email', email)
      .maybeSingle();
    if (profileLookupError) throw fromPostgresError(profileLookupError);
    const existingProfile = profileData as UserProfileRow | null;

    let profileId: string;
    if (existingProfile) {
      if (existingProfile.role !== 'couple') {
        // プランナー・管理者のアドレスでの登録。権限の混線を避けるため受け付けない。
        throw conflict('このメールアドレスは別の用途で登録されています。プランナーへご連絡ください');
      }
      profileId = existingProfile.id;
    } else {
      // 招待トークンを消費できた時点で「プランナーが発行したURLの持ち主」であることは確認済みなので
      // email_confirm: true で作成する。LINE案内の本人確認は Auth 側の確認フラグではなく
      // 「案件へ紐付けるか否か」で担保する（6-6-1）。
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { display_name: body.fullName },
      });
      if (createError || !created?.user) {
        throw unprocessable('アカウントを作成できませんでした。時間をおいて再度お試しください');
      }
      createdAuthUserId = created.user.id;

      const { data: inserted, error: insertError } = await admin
        .from('user_profiles')
        .insert({
          auth_user_id: created.user.id,
          venue_id: caseRow.venue_id,
          role: 'couple',
          // P02 の氏名は display_name にのみ設定する。
          // couple_profiles.full_name（K03 のプランナー入力値）は上書きしない（6-6-1）。
          display_name: body.fullName,
          email,
          status: 'active',
        })
        .select('id')
        .single();
      if (insertError || !inserted) throw fromPostgresError(insertError);
      profileId = (inserted as { id: string }).id;
      createdProfileId = profileId;
    }

    // (2-b) recipient_email が NULL の招待は、確認コード検証を経るまで案件へ紐付けない（6-6-1）。
    //       トークンは戻し、同じURLから続きを再開できるようにする。
    if (match === 'requires_verification' && !emailVerified) {
      await restoreInvitation();
      verificationRequired = true;
    } else {
      // (3-b) target_partner_role で特定した既存 couple_profiles に紐付ける。新規作成はしない。
      const { data: coupleData, error: coupleError } = await admin
        .from('couple_profiles')
        // memo は列レベル権限で剥奪されており select * が 42501 になるため列を明示する
        .select(COUPLE_PROFILE_COLUMNS)
        .eq('case_id', invitation.case_id)
        .eq('partner_role', invitation.target_partner_role)
        .maybeSingle();
      if (coupleError) throw fromPostgresError(coupleError);
      const coupleRow = coupleData as CoupleProfileRow | null;
      if (!coupleRow) throw notFound('招待に対応するカップル情報が見つかりません');

      if (coupleRow.user_profile_id && coupleRow.user_profile_id !== profileId) {
        throw conflict('この招待はすでに別のアカウントで登録されています');
      }

      if (coupleRow.user_profile_id !== profileId) {
        const { data: linkedRows, error: linkError } = await admin
          .from('couple_profiles')
          .update({
            user_profile_id: profileId,
            // email は暗号化対象。等値一致は併設の email_hash で行う（5-3／13-1）
            email: encryptPii(email),
            email_hash: inputEmailHash,
          })
          .eq('id', coupleRow.id)
          // 同時実行で先に紐付いた場合はここで0行になる（couple_profiles.user_profile_id は UNIQUE）
          .is('user_profile_id', null)
          .select('id');
        if (linkError) throw fromPostgresError(linkError);
        if (!linkedRows || (linkedRows as { id: string }[]).length === 0) {
          throw conflict('この招待はすでに別のアカウントで登録されています');
        }
        linkedCoupleProfile = {
          id: coupleRow.id,
          email: coupleRow.email,
          emailHash: coupleRow.email_hash,
        };
      }

      // (5) 連絡履歴の自動記録（6-6-1）
      const { error: logError } = await admin.from('communication_logs').insert({
        case_id: invitation.case_id,
        channel: 'in_app',
        direction: 'inbound',
        source: 'initial_register',
        summary: '新郎新婦が招待URLから初回登録を完了しました',
        occurred_at: new Date().toISOString(),
        created_by: profileId,
      });
      if (logError) throw fromPostgresError(logError);
    }
  } catch (error) {
    await compensate();
    throw error;
  }

  if (verificationRequired) {
    // 画面はこの応答を受けて確認コードの入力へ進む（6-6-1）。
    return ok({ status: 'verification_required', email });
  }

  // 6-6-1: 登録完了と同時にワンタイム認証でセッションを確立する。
  // 確立できなかった場合も登録は成立しているので、画面側でコード入力へ切り替える。
  const sessionEstablished = emailVerified || (await establishSession(admin, userClient, email));

  return ok({
    status: 'registered',
    sessionEstablished,
    redirectTo: landingPathFor('couple'),
  });
});
