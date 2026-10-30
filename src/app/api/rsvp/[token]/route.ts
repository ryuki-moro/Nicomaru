/**
 * POST /api/rsvp/{token} — ゲストの出欠回答（未ログイン）。
 *
 * 新郎新婦が配った共通の回答URLから、ゲスト本人と同伴者の出欠・年齢区分・性別・
 * 新郎新婦との関係・アレルギーを登録する。
 *
 * ゲストはログインしないため Service Role（表6-4 'guest.rsvp'）を使うが、
 * 触れるのは submit_guest_response() だけで、URLの照合・人数の上限・案件の特定は関数側で行う。
 * 応答には案件IDも他の回答も含めない。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { encryptPii } from '@/lib/crypto';
import { fromPostgresError, notFound, unprocessable } from '@/lib/errors';
import { GUEST_FORM_TOKEN_PATTERN } from '@/lib/services/guests';
import { hashInvitationToken } from '@/lib/services/invitations';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { guestResponseSchema } from '@/lib/validation';

import { enforceAuthRateLimit } from '../../auth/shared';

const INVALID_FORM_MESSAGE =
  'この回答URLは現在使えません。お手数ですが、新郎新婦へ新しいURLをお問い合わせください';

export const POST = route(
  async (request: Request, context: { params: Promise<{ token: string }> }) => {
    const { token } = await context.params;
    if (!GUEST_FORM_TOKEN_PATTERN.test(token)) throw notFound(INVALID_FORM_MESSAGE);
    const input = await parseBody(request, guestResponseSchema);

    const tokenHash = hashInvitationToken(token);
    // 送信元IP＋URLで数える。同じURLを使う別の回線のゲストを巻き込まない
    await enforceAuthRateLimit(request, 'guest_rsvp', tokenHash);

    const admin = createSupabaseAdminClient('guest.rsvp');
    const { data, error } = await admin.rpc('submit_guest_response', {
      p_token_hash: tokenHash,
      p_attending: input.attending,
      p_guest_side: input.guestSide,
      p_relationship: input.relationship,
      // 氏名・ふりがな・アレルギーは個人情報として暗号化して保存する（13-1）
      p_guests: input.guests.map((guest) => ({
        full_name: encryptPii(guest.fullName),
        kana: encryptPii(guest.kana),
        age_category: guest.ageCategory,
        gender: guest.gender,
        allergy_note: input.attending ? encryptPii(guest.allergyNote) : null,
        // 身体的なご事情も出席時のみ。区分は座席の手がかりにするため平文、補足は暗号化する
        assistance_needs: input.attending ? guest.assistanceNeeds : [],
        assistance_note: input.attending ? encryptPii(guest.assistanceNote) : null,
      })),
    });
    if (error) throw fromPostgresError(error);
    if (!data) throw unprocessable(INVALID_FORM_MESSAGE);

    return ok({ people: input.guests.length, attending: input.attending }, 201);
  },
);
