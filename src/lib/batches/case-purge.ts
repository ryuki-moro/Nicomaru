import type { SupabaseClient } from '@supabase/supabase-js';

import { BatchFailure, type BatchOutcome } from '@/lib/api/internal';

const RETENTION_DAYS = 180;
const PAGE_SIZE = 200;
const MAX_FAILURE_DETAILS = 20;

class PurgeStepError extends Error {
  constructor(readonly stage: string) {
    // StorageのパスやDBのエラー本文には個人情報が含まれ得るため保存しない。
    super(`削除処理に失敗しました: ${stage}`);
  }
}

async function step<T extends { error: unknown }>(
  stage: string, execute: () => PromiseLike<T>,
): Promise<T> {
  try {
    const result = await execute();
    if (result.error) throw new Error();
    return result;
  } catch {
    throw new PurgeStepError(stage);
  }
}

/**
 * 保持期間を超えた案件の既存削除対象を整理する。
 * 成功した実体のメタだけ消し、部分失敗は次回の日次実行で再処理できる状態に保つ。
 * 200件はページサイズ。完了マーカーはないため、過去の成功案件も冪等に再処理する。
 */
export async function purgeCases(admin: SupabaseClient): Promise<BatchOutcome> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  let purged = 0;
  let filesRemoved = 0;
  let failedCount = 0;
  let targetScanFailed = false;
  let aiRetentionSucceeded = false;
  let aiPayloadsCleared = 0;
  let aiRowsDeleted = 0;
  const failures: { caseId: string; stage: string }[] = [];

  async function purgeCase(caseId: string) {
    let fileCursor: string | undefined;
    for (;;) {
      const files = await step('storage_files.select', () => {
        let query = admin.from('storage_files').select('id, bucket, object_path')
          .eq('case_id', caseId).order('id').limit(PAGE_SIZE);
        if (fileCursor) query = query.gt('id', fileCursor);
        return query;
      });
      const rows = (files.data ?? []) as { id: string; bucket: string; object_path: string }[];
      if (!rows.length) break;
      for (const file of rows) {
        const removed = await step('storage.remove', () => admin.storage.from(file.bucket).remove([file.object_path]));
        // 前回実体だけ削除済みなら空配列。再実行で同じ実体を重複計上しない。
        filesRemoved += removed.data?.length ?? 0;
        await step('storage_files.delete', () => admin.from('storage_files').delete()
          .eq('case_id', caseId).eq('id', file.id));
      }
      fileCursor = rows[rows.length - 1].id;
    }

    let taskCursor: string | undefined;
    for (;;) {
      const tasks = await step('case_tasks.select', () => {
        let query = admin.from('case_tasks').select('id').eq('case_id', caseId)
          .order('id').limit(PAGE_SIZE);
        if (taskCursor) query = query.gt('id', taskCursor);
        return query;
      });
      const rows = (tasks.data ?? []) as { id: string }[];
      if (!rows.length) break;
      await step('task_submissions.delete', () => admin.from('task_submissions').delete()
        .in('case_task_id', rows.map((task) => task.id)));
      taskCursor = rows[rows.length - 1].id;
    }

    for (const table of [
      'case_guests', 'communication_logs', 'meeting_notes', 'ai_jobs', 'meeting_sheets', 'follow_logs',
    ]) {
      await step(`${table}.delete`, () => admin.from(table).delete().eq('case_id', caseId));
    }
    await step('couple_profiles.update', () => admin.from('couple_profiles').update({
      full_name: '（削除済み）', kana: null, email: null, email_hash: null,
      phone: null, address: null, memo: null,
    }).eq('case_id', caseId));
    await step('case_invitations.update', () => admin.from('case_invitations').update({
      recipient_email: null, recipient_email_hash: null,
    }).eq('case_id', caseId));
  }

  let caseCursor: string | undefined;
  try {
    for (;;) {
      const targets = await step('wedding_cases.select', () => {
        let query = admin.from('wedding_cases').select('id').not('archived_at', 'is', null)
          .lt('archived_at', cutoff).order('id').limit(PAGE_SIZE);
        if (caseCursor) query = query.gt('id', caseCursor);
        return query;
      });
      const rows = (targets.data ?? []) as { id: string }[];
      if (!rows.length) break;
      for (const target of rows) {
        try {
          await purgeCase(target.id);
          purged += 1;
        } catch (error) {
          failedCount += 1;
          if (failures.length < MAX_FAILURE_DETAILS) {
            failures.push({ caseId: target.id, stage: error instanceof PurgeStepError ? error.stage : 'unknown' });
          }
        }
      }
      caseCursor = rows[rows.length - 1].id;
    }
  } catch {
    // 一覧取得の失敗は、まだ取得していない案件数が不明なので案件失敗数と分ける。
    targetScanFailed = true;
  }

  // AI保持期間は案件と独立。案件側が一部失敗しても整理を試み、結果を別に記録する。
  try {
    const ai = await step('ai_retention', () => admin.rpc('purge_ai_job_payloads', {
      p_payload_days: 30, p_row_days: 90,
    }));
    const row = (ai.data as { payloads_cleared: number; rows_deleted: number }[] | null)?.[0];
    if (!row) throw new Error();
    aiPayloadsCleared = row.payloads_cleared;
    aiRowsDeleted = row.rows_deleted;
    aiRetentionSucceeded = true;
  } catch {
    aiRetentionSucceeded = false;
  }

  const outcome: BatchOutcome = {
    targetCount: purged,
    detail: {
      filesRemoved, retentionDays: RETENTION_DAYS, aiPayloadsCleared, aiRowsDeleted,
      failedCount, failures, targetScanFailed, aiRetentionSucceeded,
    },
  };
  if (failedCount || targetScanFailed || !aiRetentionSucceeded) {
    throw new BatchFailure('削除バッチの一部処理に失敗しました。実行記録のdetailを確認してください', outcome);
  }
  return outcome;
}
