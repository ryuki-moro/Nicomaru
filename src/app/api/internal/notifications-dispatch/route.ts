/**
 * POST /api/internal/notifications-dispatch — 通知ディスパッチ（表6-6／6-12、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-12 表6-12／6-9／付録D。
 *
 *   契機・頻度   : 日次
 *   対象範囲     : venue_id → case_id。期限N日前・期限超過を抽出し notifications を作成、
 *                  queued を送信
 *   失敗時の扱い : 10分ごとのdispatchOnly実行で、期限・回数内の同じ要求を再試行
 *   失敗の検知先 : notification_logs・S03
 *
 * 送信結果は排他的な送信権とproviderの冪等性キーで確定する。
 * 二重送信を避けるため、同じ案件・同じ宿題・同じ種別の通知はその日のうちに1通しか作らない。
 */
import { ok, route } from '@/lib/api/route';
import { BatchFailure, forEachActiveCase, runBatch } from '@/lib/api/internal';
import { COUPLE_PROFILE_COLUMNS, UNSUBMITTED_TASK_STATUSES } from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { todayInJst } from '@/lib/format';
import { fromPostgresError } from '@/lib/errors';
import { renderNotification, type NotificationType } from '@/lib/notify/templates';
import { dispatchPendingNotifications } from '@/lib/services/notifications';
import { daysBetween } from '@/lib/services/schedule';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

interface TaskRow {
  id: string;
  title: string;
  due_date: string;
  status: string;
}

// 内部呼び出しはOriginではなく、共通wrapperで共有シークレットを検証する。
export const POST = route(
  async (request: Request) => {
    // 表6-4「/api/notifications/dispatch（定期処理）｜使用する（内部バッチ）」
    const admin = createSupabaseAdminClient('cron.notifications-dispatch');
    const today = todayInJst();

    let created = 0;
    let sent = 0;
    let failed = 0;

    const outcome = await runBatch(admin, 'notifications_dispatch', async () => {
      const generation = await admin
        .from('notification_generation_runs')
        .select('completed_at,blocked_reason')
        .eq('event_on', today)
        .maybeSingle();
      if (generation.error) throw fromPostgresError(generation.error);
      let processed = 0;
      let generationFailed = false;
      const jstHour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Tokyo',
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(new Date()),
      );
      const shouldGenerate =
        !generation.data?.completed_at &&
        !generation.data?.blocked_reason &&
        (new URL(request.url).searchParams.get('dispatchOnly') !== '1' || jstHour >= 8);
      if (shouldGenerate) {
        try {
          processed = await forEachActiveCase(admin, async (caseId, venueId) => {
            // ---- 設定（期限N日前の N）。式場別があればそれを使う（6-9）
            const settings = await admin
              .from('notification_settings')
              .select('due_reminder_days_before, venue_id')
              .or(`venue_id.is.null,venue_id.eq.${venueId}`);
            if (settings.error) throw fromPostgresError(settings.error);
            const rows = (settings.data ?? []) as {
              due_reminder_days_before: number;
              venue_id: string | null;
            }[];
            const daysBefore =
              (rows.find((r) => r.venue_id === venueId) ?? rows[0])?.due_reminder_days_before ?? 7;

            // ---- 宛先。案件に紐付いた couple のうち、登録済みの利用者だけ
            const profiles = await admin
              .from('couple_profiles')
              .select(COUPLE_PROFILE_COLUMNS)
              .eq('case_id', caseId)
              .not('user_profile_id', 'is', null);
            if (profiles.error) throw fromPostgresError(profiles.error);
            const recipients = (
              (profiles.data ?? []) as unknown as { user_profile_id: string; full_name: string }[]
            ).map((p) => ({ userId: p.user_profile_id, name: readPii(p.full_name) }));
            if (recipients.length === 0) return;

            const caseRow = await admin
              .from('wedding_cases')
              .select('primary_planner_id, user_profiles ( display_name )')
              .eq('id', caseId)
              .maybeSingle();
            if (caseRow.error) throw fromPostgresError(caseRow.error);
            const plannerName =
              (caseRow.data as { user_profiles?: { display_name: string } } | null)?.user_profiles
                ?.display_name ?? '';

            // ---- 対象の宿題。未提出（not_started／needs_fix）のみ（6-8 と同じ定義）
            let taskCursor: string | undefined;
            while (true) {
              let taskQuery = admin
                .from('case_tasks')
                .select('id, title, due_date, status')
                .eq('case_id', caseId)
                .in('status', [...UNSUBMITTED_TASK_STATUSES])
                .order('id')
                .limit(500);
              if (taskCursor) taskQuery = taskQuery.gt('id', taskCursor);
              const tasks = await taskQuery;
              if (tasks.error) throw fromPostgresError(tasks.error);

              for (const task of (tasks.data ?? []) as unknown as TaskRow[]) {
                const dueDate = task.due_date.slice(0, 10);
                const remaining = daysBetween(dueDate, today);

                let type: NotificationType | null = null;
                if (remaining < 0) type = 'overdue';
                else if (remaining === daysBefore) type = 'due_reminder';
                if (!type) continue;

                for (const recipient of recipients) {
                  const rendered = renderNotification(type, {
                    coupleName: recipient.name,
                    plannerName,
                    taskName: task.title,
                    dueDate,
                    daysLeft: Math.max(remaining, 0),
                  });

                  // overdue／needs_fix は LINE を試す対象（6-9「最重要通知に限定」）。
                  // 実際に LINE を使うかは claim_line_quota() と紐付け状況で決まる。
                  const inserted = await admin
                    .from('notifications')
                    .upsert(
                      {
                        venue_id: venueId,
                        case_id: caseId,
                        recipient_user_id: recipient.userId,
                        channel: type === 'overdue' ? 'line' : 'in_app',
                        notification_type: type,
                        title: rendered.title,
                        body: rendered.body,
                        status: 'queued',
                        task_id: task.id,
                        event_on: today,
                      },
                      {
                        onConflict: 'case_id,task_id,recipient_user_id,notification_type,event_on',
                        ignoreDuplicates: true,
                      },
                    )
                    .select('id');
                  if (inserted.error) throw fromPostgresError(inserted.error);
                  created += inserted.data?.length ?? 0;
                }
              }
              if ((tasks.data?.length ?? 0) < 500) break;
              taskCursor = (tasks.data as TaskRow[]).at(-1)!.id;
            }
          });
          const completed = await admin
            .from('notification_generation_runs')
            .upsert({ event_on: today, completed_at: new Date().toISOString() });
          if (completed.error) throw fromPostgresError(completed.error);
        } catch {
          // 既に生成した通知は一意制約で保ち、未完了なら次の10分実行で生成から再試行する。
          generationFailed = true;
        }
      }

      // ---- 未送信・再試行待ち・送信権の期限切れを、ページ分割して処理する。
      const dispatched = await dispatchPendingNotifications(admin);
      sent = dispatched.sent;
      failed = dispatched.failed;
      const review = await admin
        .from('notification_deliveries')
        .select('notification_id', { count: 'exact', head: true })
        .eq('state', 'review');
      if (review.error) throw fromPostgresError(review.error);
      const result = {
        targetCount: processed,
        detail: {
          created,
          ...dispatched,
          review: review.count ?? 0,
          generationFailed,
          generationBlocked: generation.data?.blocked_reason ?? null,
        },
      };
      if (failed || review.count || generationFailed || generation.data?.blocked_reason)
        throw new BatchFailure('通知の生成失敗・再試行・要確認があります', result);
      return result;
    });

    return ok({ cases: outcome.targetCount, created, sent, failed });
  },
  { source: 'internal-cron' },
);
