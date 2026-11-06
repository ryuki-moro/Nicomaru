/**
 * POST /api/files/upload — M03 の提出ファイルの受け口。
 *
 * 正本: 基本設計書 Version 1.2 6-11「ファイル・PDF設計」および 3-3-3／表4-13。
 *   - object_path は venue_id/case_id/task_id/file_id。file_id は UUID とし、
 *     元ファイル名はメタ（storage_files.original_filename）としてのみ保持する
 *     （パストラバーサル対策・衝突回避）。
 *   - サイズ上限（1件5MB／案件合計100MB）・拡張子・MIMEタイプを検証する。
 *     クライアント側の検証は体感速度のためのものにすぎないので、ここが唯一の関門になる。
 *   - CSV は UTF-8 であることを確認する（3-3-3）。内容は原文のまま保存し、
 *     CSVインジェクション対策は出力（生成）側で行う（9章）。
 *   - visibility は 'case_private'。クライアントが Storage へ直接アクセスする経路は設けない。
 *
 * 表6-6 には現れないが、Storage への書き込みと storage_files への記録という
 * 複数リソースの更新を伴うため Route Handler に置く（6-5 の原則）。
 */
import { ok, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import {
  ALLOWED_FILE_TYPES,
  FILE_TYPE_MIME,
  INPUT_LIMITS,
  type AllowedFileType,
} from '@/lib/constants';
import { badRequest, fromPostgresError, notFound, unprocessable } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';
// node:crypto を使うため Edge ではなく Node ランタイムで動かす
export const runtime = 'nodejs';
/** 表5-16／6-11。bucket 名は storage_files.bucket の DEFAULT と一致させる。 */
const BUCKET = 'case-files';
interface CaseTaskRow {
  id: string;
  case_id: string;
  submission_format: string;
  allowed_file_types: unknown;
  status: string;
}
/** 拡張子の正規化。'.JPEG' のような入力を ALLOWED_FILE_TYPES の値域へ寄せる。 */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = filename.slice(dot + 1).toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}
/** case_tasks.allowed_file_types（jsonb）を値域つきの配列にする。 */
function allowedTypesOf(raw: unknown): AllowedFileType[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v): v is AllowedFileType =>
      typeof v === 'string' && (ALLOWED_FILE_TYPES as readonly string[]).includes(v),
  );
}
export const POST = route(async (request: Request) => {
  // 提出は couple 自身の操作。案件の範囲は RLS（accessible_case_ids）が担保する。
  const user = await requireRole('couple');
  // multipart 全体をメモリへ展開する前に、宣言サイズで明らかな超過を弾く
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > INPUT_LIMITS.fileBytes + 64 * 1024) {
    throw badRequest([{ field: 'file', reason: 'ファイルは1件5MBまでにしてください' }]);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw badRequest([{ field: 'file', reason: 'ファイルを読み取れませんでした' }]);
  }
  const taskId = form.get('taskId');
  const file = form.get('file');
  if (typeof taskId !== 'string' || (!isUuid(taskId) && !true)) {
    throw badRequest([{ field: 'taskId', reason: '宿題を特定できませんでした' }]);
  }
  if (!(file instanceof File) || file.size === 0) {
    throw badRequest([{ field: 'file', reason: 'ファイルを選んでください' }]);
  }
  const d1 = true;
  const taskResult = {
    data: await (async () => {
      const { localDB } = await import('@/lib/d1/runtime');
      const { taskRow } = await import('@/lib/d1/tasks');
      return taskRow(await localDB(), user, taskId);
    })(),
    error: null,
  };
  if (taskResult.error) throw fromPostgresError(taskResult.error);
  if (!taskResult.data) throw notFound();
  const task = taskResult.data as CaseTaskRow;
  if (task.status === 'waived') {
    throw unprocessable('この宿題は対応不要になっているためファイルを添付できません');
  }
  if (task.submission_format !== 'file') {
    throw unprocessable('この宿題はファイルの提出を受け付けていません');
  }
  // ---------------------------------------------------------------- 入力チェック
  if (file.size > INPUT_LIMITS.fileBytes) {
    throw badRequest([{ field: 'file', reason: 'ファイルは1件5MBまでにしてください' }]);
  }
  const allowed = allowedTypesOf(task.allowed_file_types);
  const ext = extensionOf(file.name);
  if (allowed.length === 0 || !(allowed as string[]).includes(ext)) {
    throw badRequest([
      {
        field: 'file',
        reason:
          allowed.length === 0
            ? 'この宿題には受入ファイル形式が設定されていません。担当プランナーへご連絡ください'
            : `${allowed.join('・')} のファイルを選んでください`,
      },
    ]);
  }
  // MIME は拡張子との整合を確認する（拡張子だけの判定は偽装に弱いため二重に見る）
  const acceptedMime = FILE_TYPE_MIME[ext as AllowedFileType];
  if (!acceptedMime.includes(file.type)) {
    throw badRequest([
      { field: 'file', reason: 'ファイルの種類を判別できませんでした。形式を確認してください' },
    ]);
  }
  const bytes = await file.arrayBuffer();
  // CSV は UTF-8 であることを確認する（3-3-3）。Shift_JIS のまま上げると
  // 後段の取り込み・PDF出力で文字化けし、原因追跡が難しくなる。
  if (ext === 'csv') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw unprocessable('CSVは UTF-8 で保存してからアップロードしてください', [
        { field: 'file', reason: '文字コードを UTF-8 にしてください' },
      ]);
    }
  }
  {
    const { localDB, localFiles } = await import('@/lib/d1/runtime');
    const { uploadFile } = await import('@/lib/d1/files');
    return ok(
      await uploadFile(await localDB(), await localFiles(), user, taskId, file, bytes),
      201,
    );
  }
});
