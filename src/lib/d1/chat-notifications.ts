import type { AppUser } from '@/lib/auth/session';
import { encryptPii, readPii } from '@/lib/crypto';
import { sendEmail } from '@/lib/notify/send';
import { renderNotification } from '@/lib/notify/templates';
import { notificationUrl } from '@/lib/services/notifications';
import type { D1Database } from '@cloudflare/workers-types';
import { captureOnly } from './mode';

const LINK_PATH = '/mypage/chat';

interface Recipient {
  user_id: string;
  full_name: string;
  email: string;
  unread: number;
}

/**
 * 担当者の投稿を、案件の新郎新婦（有効な利用者）へアプリ内通知で知らせる。
 * メールは「この案件のチャット通知が未読のものが無い」宛先にだけ送り、連投で何通も届かないようにする。
 * 本文は通知へ載せない。呼び出し側で失敗を握りつぶすこと（投稿の成否に影響させない）。
 */
export async function notifyCouplesOfStaffMessage(
  db: D1Database,
  staff: AppUser,
  caseId: string,
): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT cp.user_id,cp.full_name,u.email,
      (SELECT count(*) FROM notifications n WHERE n.case_id=cp.case_id AND n.recipient_user_id=cp.user_id
        AND n.channel='in_app' AND n.notification_type='chat_message' AND n.read_at IS NULL) AS unread
      FROM couple_profiles cp JOIN user_profiles r ON r.id=cp.user_id AND r.status='active' AND r.role='couple'
      JOIN "user" u ON u.id=cp.user_id WHERE cp.case_id=?`,
    )
    .bind(caseId)
    .all<Recipient>();
  const now = new Date().toISOString();
  for (const r of results) {
    const rendered = renderNotification('chat_message', {
      coupleName: readPii(r.full_name),
      plannerName: staff.displayName,
    });
    const insert = (channel: 'in_app' | 'email', status: string) =>
      db
        .prepare(
          `INSERT INTO notifications(id,case_id,recipient_user_id,channel,notification_type,title,body,link_path,status,sent_at,created_at)
        VALUES (?,?,?,?,'chat_message',?,?,?,?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          caseId,
          r.user_id,
          channel,
          rendered.title,
          rendered.body,
          LINK_PATH,
          status,
          status === 'sent' ? now : null,
          now,
        );
    await insert('in_app', 'sent').run();
    if (r.unread > 0) continue;
    const url = notificationUrl(LINK_PATH);
    const text = url ? `${rendered.body}\nマイページで確認する: ${url}` : rendered.body;
    if (captureOnly()) {
      // 外部送信せずローカル受信箱へ保存する（createNotification と同じ扱い）
      await db
        .prepare('INSERT INTO local_mailbox(id,payload,created_at) VALUES (?,?,?)')
        .bind(
          crypto.randomUUID(),
          encryptPii(
            JSON.stringify({ kind: 'notification', email: r.email, subject: rendered.title, text }),
          ),
          now,
        )
        .run();
      continue;
    }
    const sent = await sendEmail(r.email, rendered.title, text);
    await insert('email', sent.delivered ? 'sent' : 'failed').run();
  }
}
