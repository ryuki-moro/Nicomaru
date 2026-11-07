/**
 * POST /api/cases/{caseId}/tasks … 案件に個別宿題を追加（機能5-5、K02 宿題一覧セクション）
 *
 * 正本: 基本設計書 Version 1.2 4-3 K02／6-5 表6-6。
 *
 * 入力項目は T02（表4-17）と同一だが、逆算日数ではなく期限（日付）を直接指定し、
 * task_template_id は NULL、display_order は既存の最大値+1 とする。
 * case_tasks と timeline_items の2テーブルへ書くため、DB側の add_case_task() へ集約する。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { caseTaskCreateSchema } from '@/lib/validation';
export const POST = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        caseId: string;
      }>;
    },
  ) => {
    const user = await requireRole('planner', 'admin', 'system_admin');
    const { caseId } = await context.params;
    const input = await parseBody(request, caseTaskCreateSchema);
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { addTask } = await import('@/lib/d1/tasks');
      return ok(await addTask(await localDB(), user, caseId, input), 201);
    }
  },
);
