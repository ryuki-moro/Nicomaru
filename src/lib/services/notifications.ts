/**
 * 通知の送信（Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-9「業務ロジック：通知」／7-1〜7-3／付録D。
 *
 * LINE連携は終了した。旧データで channel='line' の通知はメールへ切り替え、
 * 切替の事実を notifications と notification_logs に残す（通知自体は落とさない）。
 * 送信時は notifications に本文と状態を保存し、送信結果を notification_logs に保存する。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { fromPostgresError } from '@/lib/errors';
import { sendEmail, type SendResult } from '@/lib/notify/send';
import type { NotificationType } from '@/lib/notify/templates';

export interface NotificationRow {
  id: string;
  venue_id: string;
  case_id: string | null;
  recipient_user_id: string;
  channel: 'line' | 'email' | 'in_app';
  notification_type: NotificationType;
  title: string;
  body: string;
  link_path?: string | null;
  status: string;
}

interface RecipientRow {
  id: string;
  email: string;
  status: string;
}

export type ResolvedChannel = 'email' | 'in_app';

export interface DispatchResult {
  notificationId: string;
  channel: ResolvedChannel;
  delivered: boolean;
  /** LINE から切り替えた場合の理由。切替はログに残す（6-9） */
  switchedFrom?: 'line';
  reason?: string;
}

/** 送信チャネルを決める。旧データの line はメールへ切り替える。 */
function resolveChannel(notification: NotificationRow): {
  channel: ResolvedChannel;
  switchedFrom?: 'line';
  reason?: string;
} {
  if (notification.channel === 'in_app') return { channel: 'in_app' };
  if (notification.channel === 'line')
    return { channel: 'email', switchedFrom: 'line', reason: 'LINE連携終了' };
  return { channel: 'email' };
}

/** 送信結果を notification_logs に残す（6-9）。 */
async function recordLog(
  client: SupabaseClient,
  notificationId: string,
  provider: 'email',
  result: SendResult,
  attemptNo: number,
): Promise<void> {
  const { error } = await client.from('notification_logs').insert({
    notification_id: notificationId,
    provider,
    provider_message_id: result.providerMessageId ?? null,
    response_json: { delivered: result.delivered, reason: result.reason ?? result.skippedReason },
    status: result.delivered ? 'success' : 'failure',
    attempt_no: attemptNo,
  });
  // ログの失敗で通知自体を巻き戻さない。送信は既に済んでいる。
  if (error) console.warn('[notify] notification_logs に記録できませんでした', error);
}

/**
 * queued の通知を1件送る。
 *
 * @param client Service Role クライアント（内部処理）。
 *   notifications の status 更新と notification_logs への書き込みは
 *   authenticated に開いていないため（付録A）、送信は必ず内部処理から行う。
 */
export async function dispatchNotification(
  client: SupabaseClient,
  notification: NotificationRow,
): Promise<DispatchResult> {
  const recipientResult = await client
    .from('user_profiles')
    .select('id, email, status')
    .eq('id', notification.recipient_user_id)
    .maybeSingle();
  if (recipientResult.error) throw fromPostgresError(recipientResult.error);
  const recipient = recipientResult.data as RecipientRow | null;

  // 停止・削除された利用者には送らない。宛先が無いのに送信を試みると
  // Resend 側でバウンスし、送信ドメインの評価を下げる。
  if (!recipient || recipient.status !== 'active') {
    await client.from('notifications').update({ status: 'cancelled' }).eq('id', notification.id);
    return {
      notificationId: notification.id,
      channel: 'in_app',
      delivered: false,
      reason: '宛先の利用者が有効ではありません',
    };
  }

  const resolved = resolveChannel(notification);

  // マイページ内通知は外部送信を伴わない。保存した時点で届いている。
  if (resolved.channel === 'in_app') {
    await client
      .from('notifications')
      .update({ status: 'sent', sent_at: new Date().toISOString(), channel: 'in_app' })
      .eq('id', notification.id);
    return { notificationId: notification.id, channel: 'in_app', delivered: true };
  }

  const url = notificationUrl(notification.link_path);
  const body = url
    ? `${notification.body}
マイページで確認する: ${url}`
    : notification.body;
  const result = await sendEmail(recipient.email, notification.title, body);

  await client
    .from('notifications')
    .update({
      // 実際に使ったチャネルへ書き換える。切替の事実が notifications 側にも残る（6-9）
      channel: resolved.channel,
      status: result.delivered ? 'sent' : 'failed',
      sent_at: result.delivered ? new Date().toISOString() : null,
    })
    .eq('id', notification.id);

  await recordLog(client, notification.id, resolved.channel, result, 1);

  return {
    notificationId: notification.id,
    channel: resolved.channel,
    delivered: result.delivered,
    switchedFrom: resolved.switchedFrom,
    reason: resolved.reason ?? result.reason ?? result.skippedReason,
  };
}

/** cronにも共通する固定の基点。未設定時にlocalhostのリンクを配信しない。 */
export function notificationUrl(path: string | null | undefined): string | null {
  if (!path || path.length > 512 || !/^\/mypage(?:\/[A-Za-z0-9_-]+)*$/.test(path)) return null;
  const base = process.env.APP_BASE_URL;
  if (!base) {
    console.warn('[notify] APP_BASE_URL未設定のため通知リンクを付与できません');
    return null;
  }
  try {
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password)
      return null;
    return new URL(path, origin).href;
  } catch {
    console.warn('[notify] APP_BASE_URLが不正のため通知リンクを付与できません');
    return null;
  }
}
