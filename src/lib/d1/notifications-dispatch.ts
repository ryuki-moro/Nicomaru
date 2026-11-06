/**
 * 通知ディスパッチ定期処理の D1 版 (6-12 / 6-9)。
 * 期限当日・超過の未提出宿題について通知を作り (同日二重作成なし)、
 * queued/pending/failed を送る。失敗は notification_logs に残し翌日再試行する。
 * LINE 連携は終了済みのため、line 指定はメールへ倒す (services/notifications の resolveChannel と同じ)。
 */
import type { D1Database } from '@cloudflare/workers-types';

import { UNSUBMITTED_TASK_STATUSES } from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { todayInJst } from '@/lib/format';
import { renderNotification, type NotificationType } from '@/lib/notify/templates';
import { notificationUrl } from '@/lib/services/notifications';
import { daysBetween } from '@/lib/services/schedule';
import { forEachActiveCaseD1 } from './batches';
import { deliverMail } from './mailbox';
import { getNotificationSettingsD1, recordNotificationLog } from './notifications';

interface NotificationRowD1 {
  id: string;
  case_id: string;
  recipient_user_id: string;
  channel: string;
  notification_type: string;
  title: string;
  body: string;
  link_path: string | null;
}

export async function dispatchOneD1(
  db: D1Database,
  row: NotificationRowD1,
): Promise<{ delivered: boolean }> {
  const recipient = await db
    .prepare(
      'SELECT u.email AS email, p.status AS status FROM user_profiles p JOIN "user" u ON u.id=p.id WHERE p.id=?',
    )
    .bind(row.recipient_user_id)
    .first<{ email: string; status: string }>();
  if (!recipient || recipient.status !== 'active') {
    await db.prepare("UPDATE notifications SET status='cancelled' WHERE id=?").bind(row.id).run();
    return { delivered: false };
  }
  if (row.channel === 'in_app') {
    await db
      .prepare("UPDATE notifications SET status='sent',sent_at=? WHERE id=?")
      .bind(new Date().toISOString(), row.id)
      .run();
    return { delivered: true };
  }
  // line は終了済みのためメールへ倒す。それ以外 (email) もメールで送る。
  const url = notificationUrl(row.link_path);
  const body = url ? `${row.body}\nマイページで確認する: ${url}` : row.body;
  const result = await deliverMail(db, {
    kind: 'notification',
    email: recipient.email,
    subject: row.title,
    text: body,
  });
  await db
    .prepare('UPDATE notifications SET channel=?,status=?,sent_at=? WHERE id=?')
    .bind(
      'email',
      result.delivered ? 'sent' : 'failed',
      result.delivered ? new Date().toISOString() : null,
      row.id,
    )
    .run();
  try {
    await recordNotificationLog(db, {
      notificationId: row.id,
      provider: 'email',
      status: result.delivered ? 'success' : 'failure',
      response: { delivered: result.delivered, reason: result.reason ?? result.skippedReason },
    });
  } catch {
    console.warn('[d1-dispatch] 送信ログを保存できませんでした', row.id);
  }
  return { delivered: result.delivered };
}

export async function dispatchNotificationsD1(db: D1Database) {
  const today = todayInJst();
  const dayStartUtc = new Date(`${today}T00:00:00+09:00`).toISOString();
  let created = 0;
  let sent = 0;
  let failed = 0;

  const processed = await forEachActiveCaseD1(db, async (caseId, venueId) => {
    const settings = await getNotificationSettingsD1(db, venueId);
    const daysBefore = settings.dueReminderDaysBefore;

    const { results: profiles } = await db
      .prepare(
        'SELECT user_id, full_name FROM couple_profiles WHERE case_id=? AND user_id IS NOT NULL',
      )
      .bind(caseId)
      .all<{ user_id: string; full_name: string }>();
    if (!profiles.length) return;
    const recipients = profiles.map((p) => ({ userId: p.user_id, name: readPii(p.full_name) }));

    const planner = await db
      .prepare(
        'SELECT u.name AS display_name FROM wedding_cases c JOIN "user" u ON u.id=c.primary_planner_id WHERE c.id=?',
      )
      .bind(caseId)
      .first<{ display_name: string }>();
    const plannerName = planner?.display_name ?? '';

    const { results: tasks } = await db
      .prepare(
        `SELECT id,title,due_date,status FROM case_tasks WHERE case_id=? AND status IN (${UNSUBMITTED_TASK_STATUSES.map(() => '?').join(',')})`,
      )
      .bind(caseId, ...UNSUBMITTED_TASK_STATUSES)
      .all<{ id: string; title: string; due_date: string; status: string }>();

    for (const task of tasks) {
      const dueDate = task.due_date.slice(0, 10);
      const remaining = daysBetween(dueDate as never, today as never);
      let type: NotificationType | null = null;
      if (remaining < 0) type = 'overdue';
      else if (remaining === daysBefore) type = 'due_reminder';
      if (!type) continue;

      for (const recipient of recipients) {
        const existing = await db
          .prepare(
            'SELECT id FROM notifications WHERE case_id=? AND recipient_user_id=? AND notification_type=? AND created_at>=? LIMIT 1',
          )
          .bind(caseId, recipient.userId, type, dayStartUtc)
          .first();
        if (existing) continue;
        const rendered = renderNotification(type, {
          coupleName: recipient.name,
          plannerName,
          taskName: task.title,
          dueDate,
          daysLeft: Math.max(remaining, 0),
        });
        const r = await db
          .prepare(
            'INSERT INTO notifications(id,case_id,recipient_user_id,channel,notification_type,title,body,link_path,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            crypto.randomUUID(),
            caseId,
            recipient.userId,
            type === 'overdue' ? 'line' : 'in_app',
            type,
            rendered.title,
            rendered.body,
            `/mypage/tasks/${task.id}`,
            'queued',
            new Date().toISOString(),
          )
          .run();
        if (r.meta.changes) created += 1;
      }
    }
  });

  const { results: queued } = await db
    .prepare(
      "SELECT id,case_id,recipient_user_id,channel,notification_type,title,body,link_path FROM notifications WHERE status IN ('queued','pending','failed') ORDER BY created_at LIMIT 500",
    )
    .all<NotificationRowD1>();
  for (const row of queued) {
    try {
      const result = await dispatchOneD1(db, row);
      if (result.delivered) sent += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { targetCount: processed, detail: { created, sent, failed }, created, sent, failed };
}
