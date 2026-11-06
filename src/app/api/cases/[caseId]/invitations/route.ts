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
import { invitationState } from '@/lib/services/invitations';
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
  'id, target_partner_role, channel, purpose, expires_at, used_at, revoked_at, ' +
  'sent_at, use_count, max_uses, created_at';
/** 送信先の解決に必要な列。couple_profiles は memo を剥奪しているため列を明示する（付録A）。 */
const CASE_WITH_PARTNERS_SELECT = `id, case_code, contact_channel,
   couple_profiles ( ${COUPLE_PROFILE_COLUMNS} )`;
interface PartnerRow {
  partner_role: PartnerRole;
  full_name: string;
  email: string | null;
  email_hash: string | null;
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
export const GET = route(
  async (
    _request: Request,
    context: {
      params: Promise<{
        caseId: string;
      }>;
    },
  ) => {
    const actor = await requireRole('planner', 'admin', 'system_admin');
    const { caseId } = await context.params;
    {
      const { localDB } = await import('@/lib/d1/runtime');
      return ok(
        await (await import('@/lib/d1/onboarding')).listInvitations(await localDB(), actor, caseId),
      );
    }
  },
);
export const POST = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        caseId: string;
      }>;
    },
  ) => {
    const actor = await requireRole('planner', 'admin', 'system_admin');
    const { caseId } = await context.params;
    {
      const input = await parseBody(request, invitationIssueSchema.strict());
      const { localDB } = await import('@/lib/d1/runtime');
      return ok(
        await (
          await import('@/lib/d1/onboarding')
        ).issueInvitation(
          await localDB(),
          actor,
          caseId,
          input.targetPartnerRole,
          input.send,
          undefined,
          input.recipientEmail,
        ),
        201,
      );
    }
  },
);
