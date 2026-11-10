/**
 * PATCH /api/cases/{caseId}/tasks/{taskId}
 *   宿題の期限変更・対応不要（waived）付与・タイトル／説明の変更（機能5-5、K02）
 *
 * 正本: 基本設計書 Version 1.2 4-3 K02／6-5 表6-6／表6-9。
 *
 * case_tasks と対応する timeline_items を同時に更新しないと、マイページ（M04）に
 * 古い期限が残る。2テーブルを1トランザクションで揃えるため update_case_task() へ集約する。
 * waived（DB値）は表6-9 により画面上は「対応不要」と表示する。
 */
import { noContent, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { caseTaskUpdateSchema } from '@/lib/validation';
export const PATCH = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        caseId: string;
        taskId: string;
      }>;
    },
  ) => {
    const user = await requireRole('planner', 'admin', 'system_admin');
    const { caseId, taskId } = await context.params;
    const input = await parseBody(request, caseTaskUpdateSchema);
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { updateTask } = await import('@/lib/d1/tasks');
      await updateTask(await localDB(), user, caseId, taskId, input);
      return noContent();
    }
  },
);
