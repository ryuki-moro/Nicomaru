/**
 * GET/POST /api/cases/{caseId}/follow-logs — フォロー記録の取得・登録（6-5 表6-6、4-3 D04）。
 *
 * 単一テーブルの操作だが 6-5 表6-6 に明記された API のため Route Handler として実装する。
 * planner_id はリクエストから受け取らずログイン中の利用者で確定させる。
 * 実施者を外部から指定できると、他プランナーの実績として記録できてしまうため（6-3-5 と同じ考え方）。
 *
 * GET は 4-3 一覧画面共通「既定の表示件数は50件、以降はページング」に従い ?offset= と ?limit= を取る。
 * 打ち切るだけでは51件目以降のフォロー記録を参照する手段が無くなるため。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireStaff } from '@/lib/auth/session';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { createFollowLog, listFollowLogs } from '@/lib/d1/follow';
import { localDB } from '@/lib/d1/runtime';
import { badRequest, notFound } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';
import { followLogSchema } from '@/lib/validation';

const SELECT_COLUMNS = 'id, case_id, planner_id, method, note, followed_at, created_at';

/**
 * ?offset= / ?limit= の読み取り。
 * 値の妥当性は API 層の責務（型・必須チェック）なので、丸めずに 400 VALIDATION_ERROR を返す。
 * 黙って丸めると、呼び出し側は取得できた件数からしかページ位置を判断できなくなる。
 */
function readPaging(request: Request): { offset: number; limit: number } {
  const params = new URL(request.url).searchParams;
  const rawOffset = params.get('offset');
  const rawLimit = params.get('limit');

  // Number('') は 0 になるため、未指定と空文字を先に既定値へ寄せる
  const offset = rawOffset === null || rawOffset === '' ? 0 : Number(rawOffset);
  if (!Number.isInteger(offset) || offset < 0) {
    throw badRequest([{ field: 'offset', reason: '0以上の整数を指定してください' }]);
  }

  const limit = rawLimit === null || rawLimit === '' ? LIST_PAGE_SIZE : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_PAGE_SIZE) {
    throw badRequest([
      { field: 'limit', reason: `1以上${LIST_PAGE_SIZE}以下の整数を指定してください` },
    ]);
  }

  return { offset, limit };
}

export const GET = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const user = await requireStaff();
    const { caseId } = await context.params;
    if (!isUuid(caseId)) throw notFound();
    const { offset, limit } = readPaging(request);
    return ok(await listFollowLogs(await localDB(), user, caseId, offset, limit));
  },
);
export const POST = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const user = await requireStaff();
    const { caseId } = await context.params;
    if (!isUuid(caseId)) throw notFound();
    const input = await parseBody(request, followLogSchema);
    return ok(await createFollowLog(await localDB(), user, caseId, input), 201);
  },
);
