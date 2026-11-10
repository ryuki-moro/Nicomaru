/**
 * GET   /api/cases/{caseId} … 案件詳細の取得
 * PATCH /api/cases/{caseId} … 案件更新（K04。担当プランナー変更・アーカイブ解除を含む）
 *
 * 正本: 基本設計書 Version 1.2 4-3 K04／6-5 表6-6／6-6-2「宿題一括割当とトランザクション境界」。
 *
 * 【差分確認ダイアログの往復（4-3 K04）】
 * 挙式日またはプラン種別を変更した場合は、確定前に差分（期限が変わる宿題・追加される宿題・
 * waived になる宿題）を提示し、プランナーの承認操作を経て適用する。
 * そのため本APIは confirmed:true を受け取るまで書き込みを行わず、プレビューだけを返す。
 * 「提示した内容」と「適用する内容」を必ず一致させるため、再計算はサービス層
 * （schedule.ts）で1度だけ行い、その結果をそのまま apply_case_update() へ渡す。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireStaff } from '@/lib/auth/session';
import { COUPLE_PROFILE_COLUMNS, type TaskStatus } from '@/lib/constants';
import { casePatchSchema } from '@/lib/validation';
interface CaseDetailRow {
  id: string;
  case_code: string;
  venue_id: string;
  plan_type_id: string | null;
  primary_planner_id: string;
  wedding_date: string;
  wedding_time: string | null;
  contact_channel: string;
  status: string;
  guest_count: number | null;
  venue_room: string | null;
  notes: string | null;
  archived_at: string | null;
  plan_types: {
    id: string;
    name: string;
  } | null;
  user_profiles: {
    id: string;
    display_name: string;
  } | null;
  couple_profiles: {
    partner_role: string;
    full_name: string;
    email: string | null;
    is_primary_contact: boolean;
  }[];
}
const CASE_DETAIL_SELECT = `id, case_code, venue_id, plan_type_id, primary_planner_id, wedding_date, wedding_time,
   contact_channel, status, guest_count, venue_room, notes, archived_at,
   plan_types ( id, name ),
   user_profiles ( id, display_name ),
   couple_profiles ( ${COUPLE_PROFILE_COLUMNS} )`;
export const GET = route(
  async (
    _request: Request,
    context: {
      params: Promise<{
        caseId: string;
      }>;
    },
  ) => {
    const user = await requireStaff();
    const { caseId } = await context.params;
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { caseRow, detailDto } = await import('@/lib/d1/cases');
      return ok(detailDto(await caseRow(await localDB(), user, caseId)));
    }
  },
);
// ------------------------------------------------------------------- K04 の更新
interface ExistingTaskRow {
  id: string;
  task_template_id: string | null;
  title: string;
  status: TaskStatus;
  due_date: string;
  task_templates: {
    due_offset_days: number;
  } | null;
}
export const PATCH = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        caseId: string;
      }>;
    },
  ) => {
    const actor = await requireStaff();
    const { caseId } = await context.params;
    {
      const input = await parseBody(request, casePatchSchema.strict());
      const { localDB } = await import('@/lib/d1/runtime');
      return ok(
        await (await import('@/lib/d1/cases')).patchCase(await localDB(), actor, caseId, input),
      );
    }
  },
);
