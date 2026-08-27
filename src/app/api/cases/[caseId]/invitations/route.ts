/**
 * GET  /api/cases/{caseId}/invitations … 招待状況一覧（K02 招待状況セクション）
 * POST /api/cases/{caseId}/invitations … 招待URL（トークン）の発行・再発行
 *
 * 正本: 基本設計書 Version 1.2 4-3 K02／6-3-6「招待トークンの保存方式」／6-5 表6-6。
 *
 * 平文トークンはDBに保存しない（6-3-6）。したがって既発行の招待URLを後から表示・再送することは
 * できず、発行・再発行のたびに「既存の有効行に revoked_at を付与 → 新規行を insert」を
 * 同一トランザクションで行い、応答で平文URLを1度だけ返す。
 * 失効と発行を別々に呼ぶとトークンが2本同時に有効な瞬間が生まれるため、DB側の1関数へ閉じている。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import {
  COUPLE_PROFILE_COLUMNS,
  type ContactChannel,
  type InvitationState,
  type PartnerRole,
} from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { fromPostgresError, notFound } from '@/lib/errors';
import { sendInvitation } from '@/lib/notify/send';
import {
  buildInvitationUrl,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiresAt,
  invitationMaxUses,
  invitationState,
} from '@/lib/services/invitations';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { invitationIssueSchema } from '@/lib/validation';

interface InvitationRow {
  id: string;
  target_partner_role: PartnerRole;
  channel: ContactChannel;
  purpose: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  sent_at: string | null;
  use_count: number;
  max_uses: number;
  created_at: string;
}

interface InvitationSummary {
  id: string;
  targetPartnerRole: PartnerRole;
  channel: ContactChannel;
  state: InvitationState;
  createdAt: string;
  expiresAt: string;
  /** 同じ相手への送信のうち最も新しいもの。再発行しても送信履歴が消えないようにする（K02） */
  lastSentAt: string | null;
}

const INVITATION_COLUMNS =
  'id, target_partner_role, channel, purpose, expires_at, used_at, revoked_at, '
  + 'sent_at, use_count, max_uses, created_at';

/** 送信先の解決に必要な列。couple_profiles は memo を剥奪しているため列を明示する（付録A）。 */
const CASE_WITH_PARTNERS_SELECT =
  `id, case_code, contact_channel,
   couple_profiles ( ${COUPLE_PROFILE_COLUMNS}, user_profiles ( id, line_user_id ) )`;

interface PartnerRow {
  partner_role: PartnerRole;
  full_name: string;
  email: string | null;
  email_hash: string | null;
  user_profiles: { id: string; line_user_id: string | null } | null;
}

/**
 * 新郎・新婦それぞれについて「いま最新の1件」を返す。
 * 再発行のたびに行が増えるため、画面には最新行だけを出し、
 * 最終送信日時のみ過去行を含めた最大値を採る（4-3 K02）。
 */
function summarize(rows: InvitationRow[], now = new Date()): InvitationSummary[] {
  const latest = new Map<PartnerRole, InvitationRow>();
  const lastSent = new Map<PartnerRole, string>();

  for (const row of rows) {
    const current = latest.get(row.target_partner_role);
    if (!current || row.created_at > current.created_at) latest.set(row.target_partner_role, row);
    if (row.sent_at) {
      const known = lastSent.get(row.target_partner_role);
      if (!known || row.sent_at > known) lastSent.set(row.target_partner_role, row.sent_at);
    }
  }

  return [...latest.values()]
    .sort((a, b) => a.target_partner_role.localeCompare(b.target_partner_role))
    .map((row) => ({
      id: row.id,
      targetPartnerRole: row.target_partner_role,
      channel: row.channel,
      state: invitationState(row, now),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSentAt: lastSent.get(row.target_partner_role) ?? null,
    }));
}

export const GET = route(async (_request: Request, context: { params: Promise<{ caseId: string }> }) => {
  await requireRole('planner', 'admin', 'system_admin');
  const { caseId } = await context.params;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('case_invitations')
    .select(INVITATION_COLUMNS)
    .eq('case_id', caseId)
    .eq('purpose', 'initial_registration');
  if (error) throw fromPostgresError(error);

  return ok({ invitations: summarize((data ?? []) as unknown as InvitationRow[]) });
});

export const POST = route(async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
  await requireRole('planner', 'admin', 'system_admin');
  const { caseId } = await context.params;
  const input = await parseBody(request, invitationIssueSchema);
  const supabase = await createSupabaseServerClient();

  const { data: caseData, error: caseError } = await supabase
    .from('wedding_cases')
    .select(CASE_WITH_PARTNERS_SELECT)
    .eq('id', caseId)
    .maybeSingle();
  if (caseError) throw fromPostgresError(caseError);
  if (!caseData) throw notFound('案件が見つかりません');

  const target = caseData as unknown as {
    id: string;
    case_code: string;
    contact_channel: ContactChannel;
    couple_profiles: PartnerRow[];
  };

  const partner = target.couple_profiles.find((p) => p.partner_role === input.targetPartnerRole);
  if (!partner) throw notFound('対象の新郎新婦プロフィールが見つかりません');

  const token = generateInvitationToken();
  const expiresAt = invitationExpiresAt('initial_registration');
  // 送信を伴う場合はそのチャネル、発行のみなら案件の連絡起点を既定にする（6-6-1）
  const channel: ContactChannel = input.send ?? target.contact_channel;

  // recipient_email は暗号化列。保存済みの暗号文とHMACをそのまま引き継ぐ（再暗号化しない）
  const { data, error } = await supabase.rpc('reissue_case_invitation', {
    p_case_id: caseId,
    p_target_partner_role: input.targetPartnerRole,
    p_purpose: 'initial_registration',
    p_token_hash: hashInvitationToken(token),
    p_channel: channel,
    p_expires_at: expiresAt.toISOString(),
    p_max_uses: invitationMaxUses('initial_registration'),
    p_recipient_email_enc: partner.email,
    p_recipient_email_hash: partner.email_hash,
  });
  if (error) throw fromPostgresError(error);

  const issued = data as { id: string; expires_at: string; channel: ContactChannel };
  const baseUrl = process.env.APP_BASE_URL ?? new URL(request.url).origin;
  const url = buildInvitationUrl(baseUrl, token);

  let sentAt: string | null = null;
  let delivered = false;
  let skippedReason: string | null = null;

  if (input.send) {
    // 宛名・宛先は暗号化列（13-1）。復号できない値で発行応答ごと 500 にすると、
    // ここでしか返らない平文の招待URLを失うため readPii で畳む（6-3-6）
    const result = await sendInvitation(
      input.send,
      {
        email: readPii(partner.email) || null,
        lineUserId: partner.user_profiles?.line_user_id ?? null,
      },
      {
        caseCode: target.case_code,
        recipientName: readPii(partner.full_name),
        invitationUrl: url,
        expiresAt: issued.expires_at,
      },
    );
    delivered = result.delivered;
    skippedReason = result.skippedReason ?? null;

    // 送信できたときだけ sent_at を進める。未構成でスキップした場合は「未送信」のままにする（13-1）
    if (delivered) {
      const { data: markedAt, error: markError } = await supabase.rpc('mark_invitation_sent', {
        p_invitation_id: issued.id,
        p_channel: input.send,
      });
      if (markError) throw fromPostgresError(markError);
      sentAt = markedAt as string | null;
    }
  }

  // 平文URLを返せるのはこの応答だけ。画面はモーダルで1度だけ表示する（6-3-6）
  return ok(
    {
      id: issued.id,
      targetPartnerRole: input.targetPartnerRole,
      channel: issued.channel,
      expiresAt: issued.expires_at,
      url,
      sentAt,
      delivered,
      skippedReason,
    },
    201,
  );
});
