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
import {
  COUPLE_PROFILE_COLUMNS,
  INCOMPLETE_TASK_STATUSES,
  LIST_PAGE_SIZE,
  PARTNER_ROLES,
  type PartnerRole,
  type TaskStatus,
} from '@/lib/constants';
import { emailHash, encryptPii, readPii } from '@/lib/crypto';
import { forbidden, fromPostgresError } from '@/lib/errors';
import {
  buildInvitationUrl,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiresAt,
  invitationMaxUses,
} from '@/lib/services/invitations';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { caseCreateSchema } from '@/lib/validation';

/** couple_profiles は memo を列レベル権限で剥奪しているため select * が 42501 になる（付録A）。 */
const CASE_LIST_SELECT =
  `id, case_code, wedding_date, status, archived_at,
   plan_types ( name ),
   couple_profiles ( ${COUPLE_PROFILE_COLUMNS} ),
   case_tasks ( status )`;

interface CaseListRow {
  id: string;
  case_code: string;
  wedding_date: string;
  status: string;
  archived_at: string | null;
  plan_types: { name: string } | null;
  couple_profiles: { partner_role: string; full_name: string }[];
  case_tasks: { status: TaskStatus }[];
}

export const GET = route(async (request: Request) => {
  await requireStaff();
  const supabase = await createSupabaseServerClient();

  const params = new URL(request.url).searchParams;
  const archived = params.get('scope') === 'archived';
  const limit = Math.min(Number(params.get('limit')) || LIST_PAGE_SIZE, LIST_PAGE_SIZE);
  const offset = Math.max(Number(params.get('offset')) || 0, 0);

  let query = supabase
    .from('wedding_cases')
    .select(CASE_LIST_SELECT)
    // 並びは挙式日順、同着は id を最終タイブレークに用いる（4-3 一覧画面共通）
    .order('wedding_date', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  // アーカイブ済みの参照可否は RLS（cases_exclude_archived）が最終防衛線。ここは導線の絞り込み。
  query = archived ? query.eq('status', 'archived') : query.neq('status', 'archived');

  const { data, error } = await query;
  if (error) throw fromPostgresError(error);

  const rows = (data ?? []) as unknown as CaseListRow[];
  return ok({
    cases: rows.map((row) => {
      const total = row.case_tasks.length;
      const incomplete = row.case_tasks.filter((t) => INCOMPLETE_TASK_STATUSES.includes(t.status)).length;
      return {
        id: row.id,
        caseCode: row.case_code,
        weddingDate: row.wedding_date,
        status: row.status,
        planTypeName: row.plan_types?.name ?? null,
        // full_name は暗号化列。参照時に復号する（13-1）。
        // 鍵が合わない値が1件あるだけで一覧全体を 500 にしないよう readPii を使う
        partners: row.couple_profiles.map((profile) => ({
          partnerRole: profile.partner_role,
          fullName: readPii(profile.full_name),
        })),
        taskTotal: total,
        taskDone: total - incomplete,
      };
    }),
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
