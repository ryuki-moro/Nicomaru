import type { SupabaseClient } from '@supabase/supabase-js';

import type { PartnerRole } from '@/lib/constants';
import { emailHash, encryptPii, normalizeEmail } from '@/lib/crypto';
import { fromPostgresError, unprocessable } from '@/lib/errors';
import { invitationState, type InvitationRow } from '@/lib/services/invitations';

interface RecipientPartner {
  partner_role: PartnerRole;
  email: string | null;
  email_hash: string | null;
}

/** スタッフのRLSセッションで、未登録の宛先だけ保存する。上書きはしない。 */
export async function saveInvitationRecipient(
  supabase: SupabaseClient,
  caseId: string,
  role: PartnerRole,
  partner: RecipientPartner,
  partners: RecipientPartner[],
  recipientEmail: string,
): Promise<{ email: string; email_hash: string }> {
  const normalized = normalizeEmail(recipientEmail);
  const hash = emailHash(normalized);
  if (partner.email !== null) {
    if (partner.email_hash === hash) return { email: partner.email, email_hash: hash };
    throw unprocessable('送信先は既に登録されています');
  }
  if (partners.some((p) => p.partner_role !== role && p.email_hash === hash)) {
    throw unprocessable('もう一方のパートナーと同じメールアドレスは指定できません');
  }
  const { data: invitations, error: lookupError } = await supabase
    .from('case_invitations')
    .select('expires_at, used_at, revoked_at, use_count, max_uses')
    .eq('case_id', caseId)
    .neq('target_partner_role', role)
    .eq('recipient_email_hash', hash);
  if (lookupError) throw fromPostgresError(lookupError);
  if ((invitations ?? []).some((row: InvitationRow) => invitationState(row) === 'unused')) {
    throw unprocessable('もう一方のパートナーの招待と同じメールアドレスは指定できません');
  }
  const encrypted = encryptPii(normalized)!;
  const { data, error } = await supabase
    .from('couple_profiles')
    .update({ email: encrypted, email_hash: hash })
    .eq('case_id', caseId)
    .eq('partner_role', role)
    .is('email', null)
    .select('email, email_hash')
    .maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw unprocessable('送信先が更新されました。画面を更新してください');
  return data as { email: string; email_hash: string };
}
