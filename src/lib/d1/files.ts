import { randomUUID } from 'node:crypto';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { AppUser } from '@/lib/auth/session';
import { INPUT_LIMITS } from '@/lib/constants';
import { notFound, unprocessable } from '@/lib/errors';
import { scope } from './cases';
import { taskRow, taskRole } from './tasks';

export async function uploadFile(
  db: D1Database,
  bucket: R2Bucket,
  user: AppUser,
  taskId: string,
  file: File,
  bytes: ArrayBuffer,
) {
  await taskRole(db, user, true);
  const task = await taskRow(db, user, taskId),
    id = randomUUID();
  // D1で容量を原子的に予約し、R2書込み失敗時は予約を戻す。
  const result = await db
    .prepare(
      `INSERT INTO storage_files(id,case_id,task_id,uploaded_by,object_path,original_filename,mime_type,file_size_bytes)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM case_tasks t JOIN wedding_cases c ON c.id=t.case_id JOIN user_profiles a ON a.id=? WHERE t.id=? AND t.version=? AND t.status<>'waived' AND t.submission_format='file' AND c.archived_at IS NULL AND a.status='active' AND a.role='couple' AND ${scope})
    AND COALESCE((SELECT SUM(file_size_bytes) FROM storage_files WHERE case_id=?),0)+?<=?`,
    )
    .bind(
      id,
      task.case_id,
      taskId,
      user.id,
      id,
      file.name.slice(0, 255),
      file.type,
      file.size,
      user.id,
      taskId,
      task.version,
      user.id,
      task.case_id,
      file.size,
      INPUT_LIMITS.caseTotalFileBytes,
    )
    .run();
  if (!result.meta.changes)
    throw unprocessable('ファイル容量の上限または宿題の状態を確認してください');
  try {
    await bucket.put(id, bytes);
  } catch (error) {
    await db.prepare('DELETE FROM storage_files WHERE id=?').bind(id).run();
    throw error;
  }
  return { fileId: id, originalFilename: file.name, sizeBytes: file.size };
}

export async function downloadFile(
  db: D1Database,
  bucket: R2Bucket,
  user: AppUser,
  id: string,
  raw: boolean,
) {
  const file = await db
    .prepare(
      `SELECT f.* FROM storage_files f JOIN wedding_cases c ON c.id=f.case_id WHERE f.id=? AND c.archived_at IS NULL AND ${scope}
    AND (f.uploaded_by=? OR EXISTS(SELECT 1 FROM task_submissions s WHERE s.file_id=f.id AND s.review_status<>'draft'))`,
    )
    .bind(id, user.id, user.id)
    .first<{ id: string; object_path: string; original_filename: string; mime_type: string }>();
  if (!file) throw notFound();
  if (!raw)
    return Response.json({
      url: `/api/files/${id}/download?raw=1`,
      fileName: file.original_filename,
      expiresIn: 0,
    });
  const object = await bucket.get(file.object_path);
  if (!object) throw notFound();
  // URL自体を権限にせず、ダウンロードのたびにセッションとDB所属を再検査する。
  return new Response(await object.arrayBuffer(), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.original_filename)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
