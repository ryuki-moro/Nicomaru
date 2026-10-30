import type { D1Database } from '@cloudflare/workers-types';
import type { AppUser } from '@/lib/auth/session';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { scope } from './cases';
import { localD1 } from './mode';
import { sendEmail } from '@/lib/notify/send';
import { notificationUrl } from '@/lib/services/notifications';
import { encryptPii, readPii } from '@/lib/crypto';
import { badRequest, notFound } from '@/lib/errors';
import { checkNotificationText, renderNotification } from '@/lib/notify/templates';
import type { z } from 'zod';
import type { notificationSendSchema } from '@/lib/validation';

export async function createNotification(
  db: D1Database,
  user: AppUser,
  input: z.infer<typeof notificationSendSchema>,
) {
  const profile = await db
    .prepare(
      `SELECT cp.full_name, u.email FROM couple_profiles cp JOIN wedding_cases c ON c.id=cp.case_id JOIN "user" u ON u.id=cp.user_id
    WHERE cp.case_id=? AND cp.user_id=? AND c.archived_at IS NULL AND ${scope}`,
    )
    .bind(input.caseId, input.recipientUserId, user.id)
    .first<{ full_name: string; email: string }>();
  if (!profile) throw notFound();
  const rendered = renderNotification(input.notificationType, {
    coupleName: readPii(profile.full_name),
    plannerName: user.displayName,
    taskName: input.taskName ?? undefined,
    dueDate: input.dueDate ?? undefined,
    reviewComment: input.comment ?? undefined,
    subject: input.subject ?? undefined,
    message: input.message ?? undefined,
  });
  const check = checkNotificationText(rendered.body);
  if (!check.ok)
    throw badRequest(check.violations.map((v) => ({ field: 'message', reason: v.reason })));
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const statement = db
    .prepare(
      `INSERT INTO notifications(id,case_id,recipient_user_id,channel,notification_type,title,body,link_path,status,sent_at,created_at)
    SELECT ?,c.id,?,?,?,?,?,?,?, ?,? FROM wedding_cases c
    WHERE c.id=? AND c.archived_at IS NULL AND ${scope}
    AND EXISTS (SELECT 1 FROM user_profiles a WHERE a.id=? AND a.status='active' AND a.role IN ('planner','admin','system_admin'))
    AND EXISTS (SELECT 1 FROM couple_profiles cp JOIN user_profiles r ON r.id=cp.user_id WHERE cp.case_id=c.id AND cp.user_id=? AND r.status='active' AND r.role='couple')
    AND (? IS NULL OR EXISTS (SELECT 1 FROM case_tasks t WHERE t.id=? AND t.case_id=c.id)) RETURNING id`,
    )
    .bind(
      id,
      input.recipientUserId,
      input.channel,
      input.notificationType,
      rendered.title,
      rendered.body,
      input.taskId ? `/mypage/tasks/${input.taskId}` : '/mypage/tasks',
      input.channel === 'in_app' ? 'sent' : 'pending',
      input.channel === 'in_app' ? now : null,
      now,
      input.caseId,
      user.id,
      user.id,
      input.recipientUserId,
      input.taskId ?? null,
      input.taskId ?? null,
    );
  const statements = [statement];
  if (input.channel === 'email' && localD1()) {
    statements.push(
      db
        .prepare(
          'INSERT INTO local_mailbox(id,payload,created_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM notifications WHERE id=?)',
        )
        .bind(
          crypto.randomUUID(),
          encryptPii(
            JSON.stringify({
              kind: 'notification',
              email: profile.email,
              subject: rendered.title,
              text: rendered.body,
            }),
          ),
          now,
          id,
        ),
    );
  }
  const results = await db.batch(statements);
  if (!results[0].results.length) throw notFound();
  if (input.channel === 'in_app' || localD1())
    return {
      notificationId: id,
      channel: input.channel,
      delivered: input.channel === 'in_app',
      switchedFrom: null,
      reason: input.channel === 'email' ? '外部送信なし。ローカル受信箱に保存しました' : null,
    };
  const url = notificationUrl(`/mypage/tasks${input.taskId ? `/${input.taskId}` : ''}`);
  const sent = await sendEmail(
    profile.email,
    rendered.title,
    url
      ? `${rendered.body}
マイページで確認する: ${url}`
      : rendered.body,
  );
  const sentAt = sent.delivered ? new Date().toISOString() : null;
  await db
    // 送信中に既読化されても送信結果を残す。既読の状態は上書きしない。
    .prepare(
      "UPDATE notifications SET status=CASE WHEN status='pending' THEN ? ELSE status END,sent_at=? WHERE id=?",
    )
    .bind(sent.delivered ? 'sent' : 'failed', sentAt, id)
    .run();
  return {
    notificationId: id,
    channel: input.channel,
    delivered: sent.delivered,
    switchedFrom: null,
    reason: sent.delivered ? null : (sent.skippedReason ?? null),
  };
}

export async function listNotifications(db: D1Database, user: AppUser, offset: number) {
  const result = await db
    .prepare(
      `SELECT n.id,n.case_id,n.channel,n.notification_type,n.title,n.body,n.status,n.sent_at,n.read_at,n.created_at,n.link_path
    FROM notifications n JOIN wedding_cases c ON c.id=n.case_id
    WHERE EXISTS (SELECT 1 FROM user_profiles a WHERE a.id=? AND a.status='active' AND (n.recipient_user_id=a.id OR (a.role<>'couple' AND ${scope})))
    ORDER BY n.created_at DESC,n.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(user.id, user.id, LIST_PAGE_SIZE + 1, offset)
    .all();
  return result.results;
}

export async function markNotificationsRead(db: D1Database, user: AppUser, ids: string[]) {
  if (!ids.length) return;
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          `UPDATE notifications SET read_at=?,status='read'
    WHERE id=? AND recipient_user_id=? AND read_at IS NULL AND EXISTS
    (SELECT 1 FROM user_profiles WHERE id=? AND status='active')`,
        )
        .bind(new Date().toISOString(), id, user.id, user.id),
    ),
  );
}
