/**
 * POST /api/files/upload — M03 の提出ファイルの受け口。
 *
 * 正本: 基本設計書 Version 1.2 6-11「ファイル・PDF設計」および 3-3-3／表4-13。
 *   - 保存先は Supabase Storage の private bucket 'case-files'。
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
import { randomUUID } from 'node:crypto';

import { ok, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import {
  ALLOWED_FILE_TYPES,
  FILE_TYPE_MIME,
  INPUT_LIMITS,
  type AllowedFileType,
} from '@/lib/constants';
import { badRequest, fromPostgresError, notFound, unprocessable } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

// node:crypto を使うため Edge ではなく Node ランタイムで動かす
export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  return raw.filter((v): v is AllowedFileType =>
    typeof v === 'string' && (ALLOWED_FILE_TYPES as readonly string[]).includes(v));
}

export const POST = route(async (request: Request) => {
  // 提出は couple 自身の操作。案件の範囲は RLS（accessible_case_ids）が担保する。
  const user = await requireRole('couple');

  // multipart 全体をメモリへ展開する前に、宣言サイズで明らかな超過を弾く
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > INPUT_LIMITS.fileBytes + 64 * 1024) {
    throw badRequest([
      { field: 'file', reason: 'ファイルは1件5MBまでにしてください' },
    ]);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw badRequest([{ field: 'file', reason: 'ファイルを読み取れませんでした' }]);
  }

  const taskId = form.get('taskId');
  const file = form.get('file');
  if (typeof taskId !== 'string' || !UUID_RE.test(taskId)) {
    throw badRequest([{ field: 'taskId', reason: '宿題を特定できませんでした' }]);
  }
  if (!(file instanceof File) || file.size === 0) {
    throw badRequest([{ field: 'file', reason: 'ファイルを選んでください' }]);
  }

  const supabase = await createSupabaseServerClient();

  const taskResult = await supabase
    .from('case_tasks')
    .select('id, case_id, submission_format, allowed_file_types, status')
    .eq('id', taskId)
    .maybeSingle();
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
        reason: allowed.length === 0
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

  // 案件あたりの合計上限（4-3 冒頭）。RLS で見えない planner_only のファイルは
  // 集計から漏れるが、couple 起点の上限判定としてはこれで足りる。
  const usedResult = await supabase
    .from('storage_files')
    .select('file_size_bytes')
    .eq('case_id', task.case_id);
  if (usedResult.error) throw fromPostgresError(usedResult.error);
  const used = ((usedResult.data ?? []) as { file_size_bytes: number | null }[])
    .reduce((sum, row) => sum + Number(row.file_size_bytes ?? 0), 0);
  if (used + file.size > INPUT_LIMITS.caseTotalFileBytes) {
    throw unprocessable('この案件のファイル容量の上限に達しました。担当プランナーへご連絡ください');
  }

  // object_path の先頭は venue_id（表5-16）。案件から辿る。
  const caseResult = await supabase
    .from('wedding_cases')
    .select('venue_id')
    .eq('id', task.case_id)
    .maybeSingle();
  if (caseResult.error) throw fromPostgresError(caseResult.error);
  if (!caseResult.data) throw notFound();
  const venueId = (caseResult.data as { venue_id: string }).venue_id;

  // ------------------------------------------------------------------ 保存
  const fileId = randomUUID();
  const objectPath = `${venueId}/${task.case_id}/${taskId}/${fileId}`;

  const uploaded = await supabase.storage.from(BUCKET).upload(objectPath, bytes, {
    contentType: file.type,
    // パスに UUID を含むため衝突しない。上書きを許すと他人のファイルを潰す余地が生まれる。
    upsert: false,
  });
  if (uploaded.error) {
    console.error('[files.upload] Storage への保存に失敗しました', objectPath, uploaded.error);
    throw unprocessable('ファイルを保存できませんでした。時間をおいてお試しください');
  }

  const inserted = await supabase
    .from('storage_files')
    .insert({
      id: fileId,
      case_id: task.case_id,
      uploaded_by: user.id,
      bucket: BUCKET,
      object_path: objectPath,
      // 元ファイル名はメタとしてのみ保持する（パスには含めない）
      original_filename: file.name.slice(0, 255),
      mime_type: file.type,
      file_size_bytes: file.size,
      visibility: 'case_private',
    })
    .select('id')
    .single();

  if (inserted.error) {
    // メタを記録できないと 6-11 の自動削除からも漏れる。実体を戻してから失敗させる。
    const rollback = await supabase.storage.from(BUCKET).remove([objectPath]);
    if (rollback.error) {
      console.error('[files.upload] 実体の巻き戻しに失敗しました', objectPath, rollback.error);
    }
    throw fromPostgresError(inserted.error);
  }

  return ok({ fileId, originalFilename: file.name, sizeBytes: file.size }, 201);
});
