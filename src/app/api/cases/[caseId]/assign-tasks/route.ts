/**
 * POST /api/cases/{caseId}/assign-tasks
 *   プラン種別テンプレートから宿題を一括割当し、タイムラインも同一トランザクションで生成する。
 *
 * 正本: 基本設計書 Version 1.2 6-5 表6-6／6-6-2「宿題一括割当とトランザクション境界」。
 *
 * 【なぜ案件登録と別APIなのか】
 * 6-6-2 で「案件登録（/api/cases）と宿題一括割当・タイムライン生成の2つのAPIで構成する」と確定している。
 * API呼び出しをまたぐ範囲（案件は登録済みだが宿題未割当）は正常に起こり得る状態として扱い、
 * プランナー画面から再度呼び出せる。再実行時は未割当のテンプレート分のみを追加し、
 * 既存 case_tasks は変更しない（エラーにはしない）。応答は追加件数で、0件でも 200 を返す。
 *
 * 自動リトライは行わない（二重作成回避）。失敗時はエラーを返し、画面側で再実行を促す。
 */
import { ok, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
export const POST = route(
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
        await (await import('@/lib/d1/onboarding')).assignTasks(await localDB(), actor, caseId),
      );
    }
  },
);
