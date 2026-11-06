/**
 * 案件終了後の自動削除・匿名化の D1 版 (6-11 / 6-12)。
 * Supabase 版 src/lib/batches/case-purge.ts と同じ契約:
 * archived_at から180日を超えた案件の個人情報・提出ファイルを消し、
 * 案件行そのものは実績として残す。ファイル実体は R2 から消す。
 * D1 に無いテーブル (meeting_notes / meeting_sheets / follow_logs / communication_logs) は
 * それらの D1 移行 (別 Wave) が入った時点で削除対象へ足す。
 */
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

import { encryptPii } from '@/lib/crypto';
import { BatchFailure, type BatchOutcome } from './batches';

const RETENTION_DAYS = 180;
const PAGE_SIZE = 200;
const MAX_FAILURE_DETAILS = 20;

export async function purgeCasesD1(db: D1Database, files?: R2Bucket | null): Promise<BatchOutcome> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  let purged = 0;
  let filesRemoved = 0;
  let failedCount = 0;
  let targetScanFailed = false;
  const failures: { caseId: string; stage: string }[] = [];

  async function purgeCase(caseId: string) {
    // ---- 提出ファイル: R2 実体 → メタの順に消す (片方だけ消えた状態で止めない)
    for (;;) {
      const { results } = await db
        .prepare('SELECT id,object_path FROM storage_files WHERE case_id=? ORDER BY id LIMIT ?')
        .bind(caseId, PAGE_SIZE)
        .all<{ id: string; object_path: string }>();
      if (!results.length) break;
      for (const file of results) {
        if (files) {
          await files.delete(file.object_path);
          filesRemoved += 1;
        }
        await db.prepare('DELETE FROM storage_files WHERE id=?').bind(file.id).run();
      }
    }
    // ---- 提出・ゲスト・通知・AI (案件に紐づくもの)
    await db
      .prepare(
        'DELETE FROM task_submissions WHERE case_task_id IN (SELECT id FROM case_tasks WHERE case_id=?)',
      )
      .bind(caseId)
      .run();
    for (const table of [
      'case_guests',
      'case_guest_forms',
      'case_guest_tags',
      'ai_jobs',
      'notifications',
    ]) {
      await db.prepare(`DELETE FROM ${table} WHERE case_id=?`).bind(caseId).run();
    }
    // ---- 匿名化 (行は残す)
    await db
      .prepare('UPDATE couple_profiles SET full_name=?,email=NULL WHERE case_id=?')
      .bind(encryptPii('（削除済み）'), caseId)
      .run();
    await db
      .prepare('UPDATE case_invitations SET recipient_email_hash=NULL WHERE case_id=?')
      .bind(caseId)
      .run();
  }

  try {
    // 案件行は消さないためページングが進まない。対象 id を先に全件引いてから処理する。
    const { results: targets } = await db
      .prepare(
        'SELECT id FROM wedding_cases WHERE archived_at IS NOT NULL AND archived_at<? ORDER BY id',
      )
      .bind(cutoff)
      .all<{ id: string }>();
    for (const target of targets) {
      try {
        await purgeCase(target.id);
        purged += 1;
      } catch {
        failedCount += 1;
        if (failures.length < MAX_FAILURE_DETAILS)
          failures.push({ caseId: target.id, stage: 'purge' });
      }
    }
  } catch {
    targetScanFailed = true;
  }

  // ---- AI 保持期間 (案件と独立: 入出力30日 / 行90日)
  let aiPayloadsCleared = 0;
  let aiRowsDeleted = 0;
  let aiRetentionSucceeded = true;
  try {
    const payloadCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const rowCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const cleared = await db
      .prepare(
        'UPDATE ai_jobs SET input_ref=?,output=NULL,reviewed_output=NULL WHERE created_at<? AND (output IS NOT NULL OR reviewed_output IS NOT NULL)',
      )
      .bind(encryptPii('{}'), payloadCutoff)
      .run();
    aiPayloadsCleared = cleared.meta.changes ?? 0;
    const deleted = await db
      .prepare('DELETE FROM ai_jobs WHERE created_at<?')
      .bind(rowCutoff)
      .run();
    aiRowsDeleted = deleted.meta.changes ?? 0;
  } catch {
    aiRetentionSucceeded = false;
  }

  const outcome: BatchOutcome = {
    targetCount: purged,
    detail: {
      filesRemoved,
      retentionDays: RETENTION_DAYS,
      aiPayloadsCleared,
      aiRowsDeleted,
      failedCount,
      failures,
      targetScanFailed,
      aiRetentionSucceeded,
      filesBucketAvailable: Boolean(files),
    },
  };
  if (failedCount || targetScanFailed || !aiRetentionSucceeded) {
    throw new BatchFailure(
      '削除バッチの一部処理に失敗しました。実行記録のdetailを確認してください',
      outcome,
    );
  }
  return outcome;
}
