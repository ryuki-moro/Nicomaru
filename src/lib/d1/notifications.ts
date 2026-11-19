import type { AppUser } from '@/lib/auth/session';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { encryptPii, readPii } from '@/lib/crypto';
import { badRequest, notFound } from '@/lib/errors';
import { sendEmail } from '@/lib/notify/send';
import { checkNotificationText, renderNotification } from '@/lib/notify/templates';
import { notificationUrl } from '@/lib/services/notifications';
import type { notificationSendSchema } from '@/lib/validation';
import type { D1Database } from '@cloudflare/workers-types';
import type { z } from 'zod';
import { scope } from './cases';
import { captureOnly } from './mode';

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
  if (input.channel === 'email' && captureOnly()) {
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
  if (input.channel === 'in_app' || captureOnly())
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
  // 送信ログ (0013)。ログ欠落で通知送信自体を失敗扱いにはしない。
  try {
    await recordNotificationLog(db, {
      notificationId: id,
      provider: 'email',
      status: sent.delivered ? 'success' : 'failure',
    });
  } catch {
    console.warn('[d1-notifications] 送信ログを保存できませんでした', id);
  }
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

// ---- 0013: 送信ログ・設定・上限カウンタ (6-9) ----

export interface NotificationLogExportRowD1 {
  id: string;
  provider: 'line' | 'email';
  status: 'success' | 'failure';
  provider_message_id: string | null;
  created_at: string;
  notifications: {
    notification_type: string;
    venues: { name: string } | null;
    wedding_cases: { case_code: string } | null;
  } | null;
}

export async function recordNotificationLog(
  db: D1Database,
  input: {
    notificationId: string;
    provider: 'line' | 'email';
    status: 'success' | 'failure';
    providerMessageId?: string | null;
    response?: unknown;
    attemptNo?: number;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO notification_logs(id,notification_id,provider,provider_message_id,response_json,status,attempt_no,created_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .bind(
      id,
      input.notificationId,
      input.provider,
      input.providerMessageId ?? null,
      input.response === undefined ? null : JSON.stringify(input.response),
      input.status,
      input.attemptNo ?? 1,
      new Date().toISOString(),
    )
    .run();
  return id;
}

export async function loadNotificationLogsForExportD1(
  db: D1Database,
  period: { from?: string; toExclusive?: string } = {},
): Promise<NotificationLogExportRowD1[]> {
  const MAX = 10_001;
  const where: string[] = [];
  const binds: unknown[] = [];
  if (period.from) {
    where.push('l.created_at>=?');
    binds.push(period.from);
  }
  if (period.toExclusive) {
    where.push('l.created_at<?');
    binds.push(period.toExclusive);
  }
  const { results } = await db
    .prepare(
      `SELECT l.id,l.provider,l.status,l.provider_message_id,l.created_at,
        n.notification_type AS n_type, v.name AS venue_name, c.case_code AS case_code
       FROM notification_logs l
       LEFT JOIN notifications n ON n.id=l.notification_id
       LEFT JOIN wedding_cases c ON c.id=n.case_id
       LEFT JOIN venues v ON v.id=c.venue_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY l.created_at DESC,l.id DESC LIMIT ?`,
    )
    .bind(...binds, MAX)
    .all<{
      id: string;
      provider: 'line' | 'email';
      status: 'success' | 'failure';
      provider_message_id: string | null;
      created_at: string;
      n_type: string | null;
      venue_name: string | null;
      case_code: string | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    provider: r.provider,
    status: r.status,
    provider_message_id: r.provider_message_id,
    created_at: r.created_at,
    notifications: r.n_type
      ? {
          notification_type: r.n_type,
          venues: r.venue_name ? { name: r.venue_name } : null,
          wedding_cases: r.case_code ? { case_code: r.case_code } : null,
        }
      : null,
  }));
}

export interface NotificationSettingsD1 {
  linePerCasePerWeek: number;
  linePerVenuePerMonth: number;
  dueReminderDaysBefore: number;
}

/** 式場別があればそれを、無ければシステム既定 (venue_id NULL) を返す。 */
export async function getNotificationSettingsD1(
  db: D1Database,
  venueId: string,
): Promise<NotificationSettingsD1> {
  const row = await db
    .prepare(
      `SELECT line_per_case_per_week,line_per_venue_per_month,due_reminder_days_before
       FROM notification_settings WHERE venue_id=? OR venue_id IS NULL
       ORDER BY (venue_id IS NULL) ASC LIMIT 1`,
    )
    .bind(venueId)
    .first<{
      line_per_case_per_week: number;
      line_per_venue_per_month: number;
      due_reminder_days_before: number;
    }>();
  return {
    linePerCasePerWeek: row?.line_per_case_per_week ?? 1,
    linePerVenuePerMonth: row?.line_per_venue_per_month ?? 180,
    dueReminderDaysBefore: row?.due_reminder_days_before ?? 7,
  };
}

/** 送信成功をカウンタへ原子的に加算する (UNIQUE + upsert)。 */
export async function incrementNotificationQuotaD1(
  db: D1Database,
  scopeKind: 'case_week' | 'venue_month',
  scopeId: string,
  windowStart: string,
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO notification_quota_counters(id,scope,scope_id,window_start,sent_count)
       VALUES (?,?,?,?,1)
       ON CONFLICT(scope,scope_id,window_start) DO UPDATE SET sent_count=sent_count+1,updated_at=CURRENT_TIMESTAMP
       RETURNING sent_count`,
    )
    .bind(crypto.randomUUID(), scopeKind, scopeId, windowStart)
    .first<{ sent_count: number }>();
  return row?.sent_count ?? 0;
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

/** スタッフの所属・担当範囲にある案件の送信履歴。 */
export async function staffNotificationHistory(
  db: D1Database,
  user: AppUser,
  offset = 0,
  limit = 50,
) {
  if (user.role === 'couple') throw (await import('@/lib/errors')).forbidden();
  const { results } = await db
    .prepare(
      `SELECT n.*,c.case_code FROM notifications n JOIN wedding_cases c ON c.id=n.case_id WHERE ${scope} ORDER BY n.created_at DESC,n.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(user.id, limit + 1, offset)
    .all<{
      id: string;
      case_id: string;
      channel: string;
      notification_type: import('@/lib/notify/templates').NotificationType;
      title: string;
      status: string;
      sent_at: string | null;
      created_at: string;
      case_code: string;
    }>();
  return Promise.all(
    results.map(async (row) => ({
      ...row,
      wedding_cases: { case_code: row.case_code },
      notification_logs: (
        await db
          .prepare(
            'SELECT provider,status,attempt_no FROM notification_logs WHERE notification_id=? ORDER BY created_at,id',
          )
          .bind(row.id)
          .all<{ provider: string; status: string; attempt_no: number }>()
      ).results,
    })),
  );
}
