/**
 * POST /api/internal/notifications-dispatch — 通知ディスパッチ（表6-6／6-12、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-12 表6-12／6-9／付録D。
 *
 *   契機・頻度   : 日次
 *   対象範囲     : venue_id → case_id。期限N日前・期限超過を抽出し notifications を作成、
 *                  queued を送信
 *   失敗時の扱い : 送信失敗は notification_logs に failure を記録し翌日再試行
 *   失敗の検知先 : notification_logs・S03
 *
 * 「翌日再試行」を成立させるため、送信に失敗した通知は status を failed にしたうえで
 * 翌日の実行で再び拾えるようにする（queued へ戻す）。
 * 二重送信を避けるため、同じ案件・同じ宿題・同じ種別の通知はその日のうちに1通しか作らない。
 */
import { ok, route } from '@/lib/api/route';
import { forEachActiveCase, requireInternalCall, runBatch } from '@/lib/api/internal';
import { COUPLE_PROFILE_COLUMNS, UNSUBMITTED_TASK_STATUSES } from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { todayInJst } from '@/lib/format';
import { renderNotification, type NotificationType } from '@/lib/notify/templates';
import { dispatchNotification, type NotificationRow } from '@/lib/services/notifications';
import { daysBetween } from '@/lib/services/schedule';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

interface TaskRow {
  id: string;
  title: string;
  due_date: string;
  status: string;
}

export const POST = route(async (request: Request) => {
  requireInternalCall(request);

  // 表6-4「/api/notifications/dispatch（定期処理）｜使用する（内部バッチ）」
  const admin = createSupabaseAdminClient('cron.notifications-dispatch');
  const today = todayInJst();

  let created = 0;
  let sent = 0;
  let failed = 0;

  const outcome = await runBatch(admin, 'notifications_dispatch', async () => {
    const processed = await forEachActiveCase(admin, async (caseId, venueId) => {
      // ---- 設定（期限N日前の N）。式場別があればそれを使う（6-9）
      const settings = await admin
        .from('notification_settings')
        .select('due_reminder_days_before, venue_id')
        .or(`venue_id.is.null,venue_id.eq.${venueId}`);
      const rows = (settings.data ?? []) as { due_reminder_days_before: number; venue_id: string | null }[];
      const daysBefore = (rows.find((r) => r.venue_id === venueId) ?? rows[0])
        ?.due_reminder_days_before ?? 7;

      // ---- 宛先。案件に紐付いた couple のうち、登録済みの利用者だけ
      const profiles = await admin
        .from('couple_profiles')
        .select(COUPLE_PROFILE_COLUMNS)
        .eq('case_id', caseId)
        .not('user_profile_id', 'is', null);
      const recipients = ((profiles.data ?? []) as unknown as
        { user_profile_id: string; full_name: string }[])
        .map((p) => ({ userId: p.user_profile_id, name: readPii(p.full_name) }));
      if (recipients.length === 0) return;

      const caseRow = await admin
        .from('wedding_cases')
        .select('primary_planner_id, user_profiles ( display_name )')
        .eq('id', caseId)
        .maybeSingle();
      const plannerName =
        (caseRow.data as { user_profiles?: { display_name: string } } | null)
          ?.user_profiles?.display_name ?? '';

      // ---- 対象の宿題。未提出（not_started／needs_fix）のみ（6-8 と同じ定義）
      const tasks = await admin
        .from('case_tasks')
        .select('id, title, due_date, status')
        .eq('case_id', caseId)
        .in('status', [...UNSUBMITTED_TASK_STATUSES]);

      for (const task of (tasks.data ?? []) as unknown as TaskRow[]) {
        const dueDate = task.due_date.slice(0, 10);
        const remaining = daysBetween(dueDate, today);

        let type: NotificationType | null = null;
        if (remaining < 0) type = 'overdue';
        else if (remaining === daysBefore) type = 'due_reminder';
        if (!type) continue;

        for (const recipient of recipients) {
          // 同じ案件・同じ種別の通知をその日に二重に作らない。
          // pg_cron の再実行や手動起動で同じ通知が積み上がるのを防ぐ。
          const existing = await admin
            .from('notifications')
            .select('id')
            .eq('case_id', caseId)
            .eq('recipient_user_id', recipient.userId)
            .eq('notification_type', type)
            .gte('created_at', `${today}T00:00:00+09:00`)
            .limit(1);
          if ((existing.data ?? []).length > 0) continue;

          const rendered = renderNotification(type, {
            coupleName: recipient.name,
            plannerName,
            taskName: task.title,
            dueDate,
            daysLeft: Math.max(remaining, 0),
          });

          // overdue／needs_fix は LINE を試す対象（6-9「最重要通知に限定」）。
          // 実際に LINE を使うかは claim_line_quota() と紐付け状況で決まる。
          const inserted = await admin.from('notifications').insert({
            venue_id: venueId,
            case_id: caseId,
            recipient_user_id: recipient.userId,
            channel: type === 'overdue' ? 'line' : 'in_app',
            notification_type: type,
            title: rendered.title,
            body: rendered.body,
            status: 'queued',
          }).select('id').single();
          if (!inserted.error) created += 1;
        }
      }
    });

    // ---- queued をまとめて送る。前日の failed もここで拾い直す（6-12「翌日再試行」）
    const queued = await admin
      .from('notifications')
      .select('id, venue_id, case_id, recipient_user_id, channel, notification_type, title, body, status')
      .in('status', ['queued', 'failed'])
      .limit(500);

    for (const row of (queued.data ?? []) as unknown as NotificationRow[]) {
      try {
        const result = await dispatchNotification(admin, row);
        if (result.delivered) sent += 1;
        else failed += 1;
      } catch {
        // 1件の失敗で残りを止めない。status は failed のまま翌日拾い直される。
        failed += 1;
      }
    }

    return { targetCount: processed, detail: { created, sent, failed } };
  });

  return ok({ cases: outcome.targetCount, created, sent, failed });
});
