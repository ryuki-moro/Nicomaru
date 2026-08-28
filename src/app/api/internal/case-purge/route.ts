/**
 * POST /api/internal/case-purge — 案件終了後の自動削除・匿名化（6-12、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-11／6-12 表6-12／13-1。
 *
 *   契機・頻度   : 日次
 *   対象範囲     : archived_at が保持期間を超過した案件。
 *                  DBレコードの削除・匿名化と Storage 実体の削除
 *   失敗時の扱い : 自動リトライなし。件数を実行記録に残す
 *   失敗の検知先 : 実行記録・監査（9-1）
 *
 * 保持期間は 13-1 の開発チーム決定により **archived_at から180日**。
 * 監査ログ（audit_logs）と通知送信ログ（notification_logs）は
 * 「別途の保持期間ポリシーに従い自動削除の対象外」（6-11）なので触らない。
 *
 * 【匿名化ではなく削除にしている範囲】
 * 6-11 は「個人情報・ゲスト情報・提出ファイルを自動削除対象とする」と定める。
 * 案件そのものの行は残す（案件番号・挙式日は式場の実績として意味があり、
 * 消すと audit_logs から辿れなくなる）。個人が特定できる列だけを落とす。
 */
import { ok, route } from '@/lib/api/route';
import { requireInternalCall, runBatch } from '@/lib/api/internal';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

/** 13-1「案件終了（archived_at）から180日」。差し戻しはこの定数の変更で完結する。 */
const RETENTION_DAYS = 180;

export const POST = route(async (request: Request) => {
  requireInternalCall(request);

  const admin = createSupabaseAdminClient('cron.risk-recalculate');
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let purged = 0;
  let filesRemoved = 0;

  const outcome = await runBatch(admin, 'case_purge', async () => {
    const targets = await admin
      .from('wedding_cases')
      .select('id, venue_id')
      .not('archived_at', 'is', null)
      .lt('archived_at', cutoff)
      .limit(200);
    if (targets.error) throw new Error(targets.error.message);

    for (const target of (targets.data ?? []) as { id: string }[]) {
      // ---- Storage の実体を先に消す。メタだけ消すとパスを見失い、二度と消せなくなる（6-7 と同じ順序）
      const files = await admin
        .from('storage_files')
        .select('id, bucket, object_path')
        .eq('case_id', target.id);
      for (const file of (files.data ?? []) as
        { id: string; bucket: string; object_path: string }[]) {
        const removed = await admin.storage.from(file.bucket).remove([file.object_path]);
        if (!removed.error) filesRemoved += 1;
      }
      await admin.from('storage_files').delete().eq('case_id', target.id);

      // ---- 提出内容・ゲスト情報・連絡履歴・打ち合わせ記録を削除（6-11）
      const taskIds = await admin.from('case_tasks').select('id').eq('case_id', target.id);
      const ids = ((taskIds.data ?? []) as { id: string }[]).map((t) => t.id);
      if (ids.length > 0) {
        await admin.from('task_submissions').delete().in('case_task_id', ids);
      }
      await admin.from('case_guests').delete().eq('case_id', target.id);
      await admin.from('communication_logs').delete().eq('case_id', target.id);
      await admin.from('meeting_notes').delete().eq('case_id', target.id);
      await admin.from('meeting_sheets').delete().eq('case_id', target.id);
      await admin.from('follow_logs').delete().eq('case_id', target.id);

      // ---- カップルの個人情報を匿名化（行は残す。案件との対応が消えると監査で追えない）
      await admin.from('couple_profiles').update({
        full_name: '（削除済み）',
        kana: null,
        email: null,
        email_hash: null,
        phone: null,
        address: null,
        memo: null,
      }).eq('case_id', target.id);

      // ---- 招待は平文を持たないが、宛先メールのハッシュは個人に紐づくため落とす
      await admin.from('case_invitations').update({
        recipient_email: null,
        recipient_email_hash: null,
      }).eq('case_id', target.id);

      purged += 1;
    }

    return { targetCount: purged, detail: { filesRemoved, retentionDays: RETENTION_DAYS } };
  });

  return ok({ purged: outcome.targetCount, filesRemoved });
});
