/**
 * GET  /api/cases … 案件一覧の取得（K01 と同じ絞り込み条件をAPIとしても提供する）
 * POST /api/cases … 案件登録（K03）
 *
 * 正本: 基本設計書 Version 1.2 3-3-2「2-1 案件登録」／5-7／6-5 表6-6／6-6-1／6-6-2。
 *
 * 案件登録は wedding_cases・couple_profiles×2・case_invitations×2・communication_logs へ
 * 書き込むため、6-6-2 の「途中失敗時は全体をロールバックする」を満たす必要がある。
 * Supabase JS はクライアント側でトランザクションを張れないので、
 * 一連の書き込みは security definer 関数 create_wedding_case()（20260828000800）へ集約し、
 * ここからは RPC を1回だけ呼ぶ。case_code の採番と UNIQUE 違反時の再試行（5-7）も関数内で行う。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole, requireStaff } from '@/lib/auth/session';
import { LIST_PAGE_SIZE, PARTNER_ROLES, type PartnerRole } from '@/lib/constants';
import { emailHash, encryptPii } from '@/lib/crypto';
import { forbidden, fromPostgresError } from '@/lib/errors';
import { loadCaseList } from '@/lib/services/cases';
import {
  buildInvitationUrl,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiresAt,
  invitationMaxUses,
} from '@/lib/services/invitations';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { caseCreateSchema } from '@/lib/validation';

export const GET = route(async (request: Request) => {
  await requireStaff();
  const supabase = await createSupabaseServerClient();

  const params = new URL(request.url).searchParams;
  const limit = Math.min(Number(params.get('limit')) || LIST_PAGE_SIZE, LIST_PAGE_SIZE);
  const offset = Math.max(Number(params.get('offset')) || 0, 0);

  // 一覧の組み立ては K01 画面と同じサービス層を使う。
  // 以前はここに別の実装があり、q（キーワード）を無視してリスクも返していなかった（#18）。
  const result = await loadCaseList(supabase, {
    scope: params.get('scope') === 'archived' ? 'archived' : 'active',
    sort: params.get('sort') === 'risk' ? 'risk' : 'wedding_date',
    keyword: params.get('q'),
    offset,
    limit,
  });

  return ok({
    cases: result.items.map((row) => ({
      id: row.id,
      caseCode: row.caseCode,
      weddingDate: row.weddingDate,
      status: row.status,
      planTypeName: row.planTypeName,
      partners: row.partners,
      taskTotal: row.total,
      taskDone: row.done,
      risk: row.risk,
    })),
    hasNext: result.hasNext,
  });
});

export const POST = route(async (request: Request) => {
  // K03 は planner の画面だが、API は planner／admin を許可する（6-5 表6-6）
  const actor = await requireRole('planner', 'admin');
  if (!actor.venueId) throw forbidden('式場に所属していない利用者は案件を登録できません');

  const input = await parseBody(request, caseCreateSchema);
  const supabase = await createSupabaseServerClient();

  // 6-6-1: 案件登録時に新郎・新婦の2件（purpose='initial_registration'）を発行する。
  // 平文トークンはDBに保存しないため（6-3-6）、ここで生成した値だけが応答で1度だけ返せる。
  const expiresAt = invitationExpiresAt('initial_registration');
  const issued = PARTNER_ROLES.map((partnerRole) => ({
    partnerRole,
    token: generateInvitationToken(),
  }));

  const { data, error } = await supabase.rpc('create_wedding_case', {
    p_wedding_date: input.weddingDate,
    p_wedding_time: input.weddingTime ?? null,
    p_plan_type_id: input.planTypeId,
    p_contact_channel: input.contactChannel,
    p_guest_count: input.guestCount ?? 0,
    p_venue_room: input.venueRoom ?? null,
    p_notes: input.notes ?? null,
    p_primary_contact: input.primaryContact,
    p_groom_name_enc: encryptPii(input.groomName),
    p_bride_name_enc: encryptPii(input.brideName),
    p_contact_email_enc: encryptPii(input.contactEmail),
    p_contact_email_hash: emailHash(input.contactEmail),
    p_invitations: issued.map((entry) => ({
      target_partner_role: entry.partnerRole,
      token_hash: hashInvitationToken(entry.token),
      // 送付経路の既定は wedding_cases.contact_channel に従う（6-6-1）
      channel: input.contactChannel,
      purpose: 'initial_registration',
      expires_at: expiresAt.toISOString(),
      max_uses: invitationMaxUses('initial_registration'),
    })),
  });
  if (error) throw fromPostgresError(error);

  const created = data as {
    case_id: string;
    case_code: string;
    invitations: {
      id: string;
      target_partner_role: PartnerRole;
      channel: string;
      expires_at: string;
    }[];
  };

  const baseUrl = process.env.APP_BASE_URL ?? new URL(request.url).origin;

  // この 201 応答が招待URLの平文を得られる唯一の機会。以後は K02 から再発行する（6-3-6）。
  return ok(
    {
      caseId: created.case_id,
      caseCode: created.case_code,
      invitations: created.invitations.map((invitation) => ({
        id: invitation.id,
        targetPartnerRole: invitation.target_partner_role,
        channel: invitation.channel,
        expiresAt: invitation.expires_at,
        url: buildInvitationUrl(
          baseUrl,
          issued.find((entry) => entry.partnerRole === invitation.target_partner_role)?.token ?? '',
        ),
      })),
    },
    201,
  );
});
