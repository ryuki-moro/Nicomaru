/**
 * POST /api/cases/{caseId}/invitations/{invitationId}/send
 *   指定の招待を再発行し、新しい招待URLをメール（Resend）またはLINEで送信する。
 *
 * 正本: 基本設計書 Version 1.2 4-3 K02／6-3-6／6-5 表6-6。
 *
 * 平文トークンを保存しない設計のため、送信は必ず再発行を伴う。
 * したがって {invitationId} は「誰宛の招待か（target_partner_role）」を特定するための入力であり、
 * この行自体は revoked_at が付いて失効する。応答の id は新しく発行された行を指す。
 * 成功時に sent_at を記録する。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import {
  COUPLE_PROFILE_COLUMNS,
  INVITATION_PURPOSES,
  type ContactChannel,
  type InvitationPurpose,
  type PartnerRole,
} from '@/lib/constants';
import { decryptPii } from '@/lib/crypto';
import { fromPostgresError, notFound } from '@/lib/errors';
import { sendInvitation } from '@/lib/notify/send';
import {
  buildInvitationUrl,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiresAt,
  invitationMaxUses,
} from '@/lib/services/invitations';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { invitationSendSchema } from '@/lib/validation';

interface PartnerRow {
  partner_role: PartnerRole;
  full_name: string;
  email: string | null;
  email_hash: string | null;
  user_profiles: { id: string; line_user_id: string | null } | null;
}

export const POST = route(
  async (request: Request, context: { params: Promise<{ caseId: string; invitationId: string }> }) => {
    await requireRole('planner', 'admin', 'system_admin');
    const { caseId, invitationId } = await context.params;
    const input = await parseBody(request, invitationSendSchema);
    const supabase = await createSupabaseServerClient();

    // 対象の招待から「誰宛か」だけを取り出す。トークン本体は保存していない（6-3-6）
    const { data: invitationData, error: invitationError } = await supabase
      .from('case_invitations')
      .select('id, case_id, target_partner_role, purpose')
      .eq('id', invitationId)
      .eq('case_id', caseId)
      .maybeSingle();
    if (invitationError) throw fromPostgresError(invitationError);
    if (!invitationData) throw notFound('招待が見つかりません');
    const invitation = invitationData as {
      target_partner_role: PartnerRole;
      purpose: string;
    };

    const { data: caseData, error: caseError } = await supabase
      .from('wedding_cases')
      .select(
        `id, case_code, couple_profiles ( ${COUPLE_PROFILE_COLUMNS}, user_profiles ( id, line_user_id ) )`,
      )
      .eq('id', caseId)
      .maybeSingle();
    if (caseError) throw fromPostgresError(caseError);
    if (!caseData) throw notFound('案件が見つかりません');
    const target = caseData as unknown as {
      case_code: string;
      couple_profiles: PartnerRow[];
    };

    const partner = target.couple_profiles.find(
      (p) => p.partner_role === invitation.target_partner_role,
    );
    if (!partner) throw notFound('対象の新郎新婦プロフィールが見つかりません');

    const channel: ContactChannel = input.channel;
    const token = generateInvitationToken();
    // 有効期限・使用回数上限は purpose ごとに異なる（6-3-6／13-1）。
    // 元の招待の purpose を引き継ぎ、initial_registration の値を他用途へ流用しない。
    const purpose: InvitationPurpose = INVITATION_PURPOSES.includes(
      invitation.purpose as InvitationPurpose,
    )
      ? (invitation.purpose as InvitationPurpose)
      : 'initial_registration';
    const expiresAt = invitationExpiresAt(purpose);

    const { data, error } = await supabase.rpc('reissue_case_invitation', {
      p_case_id: caseId,
      p_target_partner_role: invitation.target_partner_role,
      p_purpose: purpose,
      p_token_hash: hashInvitationToken(token),
      p_channel: channel,
      p_expires_at: expiresAt.toISOString(),
      p_max_uses: invitationMaxUses(purpose),
      p_recipient_email_enc: partner.email,
      p_recipient_email_hash: partner.email_hash,
    });
    if (error) throw fromPostgresError(error);

    const issued = data as { id: string; expires_at: string };
    const baseUrl = process.env.APP_BASE_URL ?? new URL(request.url).origin;
    const url = buildInvitationUrl(baseUrl, token);

    const result = await sendInvitation(
      channel,
      { email: decryptPii(partner.email), lineUserId: partner.user_profiles?.line_user_id ?? null },
      {
        caseCode: target.case_code,
        recipientName: decryptPii(partner.full_name) ?? '',
        invitationUrl: url,
        expiresAt: issued.expires_at,
      },
    );

    let sentAt: string | null = null;
    if (result.delivered) {
      const { data: markedAt, error: markError } = await supabase.rpc('mark_invitation_sent', {
        p_invitation_id: issued.id,
        p_channel: channel,
      });
      if (markError) throw fromPostgresError(markError);
      sentAt = markedAt as string | null;
    }

    // 送信が未構成でスキップされた場合でも再発行は成立している。
    // ここで平文URLを返さないと発行した招待に誰も到達できなくなるため、応答に含める（6-3-6）。
    return ok({
      id: issued.id,
      targetPartnerRole: invitation.target_partner_role,
      channel,
      expiresAt: issued.expires_at,
      url,
      sentAt,
      delivered: result.delivered,
      skippedReason: result.skippedReason ?? null,
    });
  },
);
