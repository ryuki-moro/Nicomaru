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
import { clientIp } from '@/lib/d1/mode';
import { notFound, unprocessable } from '@/lib/errors';
import { GUEST_FORM_TOKEN_PATTERN } from '@/lib/services/guests';
import { hashInvitationToken } from '@/lib/services/invitations';
import { guestResponseSchema } from '@/lib/validation';
const INVALID_FORM_MESSAGE =
  'この回答URLは現在使えません。お手数ですが、新郎新婦へ新しいURLをお問い合わせください';
export const POST = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        token: string;
      }>;
    },
  ) => {
    const { token } = await context.params;
    if (!GUEST_FORM_TOKEN_PATTERN.test(token)) throw notFound(INVALID_FORM_MESSAGE);
    const input = await parseBody(request, guestResponseSchema);
    const tokenHash = hashInvitationToken(token);
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { guestRsvpLimit } = await import('@/lib/d1/auth-limits');
      const { submitGuestResponse } = await import('@/lib/d1/guests');
      const db = await localDB();
      await guestRsvpLimit(db, tokenHash, clientIp(request.headers));
      if (!(await submitGuestResponse(db, tokenHash, input)))
        throw unprocessable(INVALID_FORM_MESSAGE);
      return ok({ people: input.guests.length, attending: input.attending }, 201);
    }
  },
);
