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
import { type PartnerRole } from '@/lib/constants';
import { invitationSendSchema } from '@/lib/validation';
interface PartnerRow {
  partner_role: PartnerRole;
  full_name: string;
  email: string | null;
  email_hash: string | null;
}
export const POST = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        caseId: string;
        invitationId: string;
      }>;
    },
  ) => {
    const actor = await requireRole('planner', 'admin', 'system_admin');
    const { caseId, invitationId } = await context.params;
    {
      const input = await parseBody(request, invitationSendSchema.strict());
      const { localDB } = await import('@/lib/d1/runtime');
      return ok(
        await (
          await import('@/lib/d1/onboarding')
        ).issueInvitation(
          await localDB(),
          actor,
          caseId,
          'bride',
          input.channel,
          invitationId,
          input.recipientEmail,
        ),
      );
    }
  },
);
