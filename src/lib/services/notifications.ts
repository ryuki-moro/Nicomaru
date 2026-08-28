/**
 * 通知の送信（Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-9「業務ロジック：通知」／7-1〜7-3／付録D。
 *
 * 6-9 の方針をそのまま形にしている:
 *   - LINE紐付け済みの利用者には LINE、未紐付けの利用者にはメール（Resend）で送信する
 *   - LINE通知は最重要通知に限定し、送信上限に達した場合はメール通知へ自動で切り替える
 *   - **上限到達時も通知自体は落とさない**。切替をログに残す
 *   - 送信時は notifications に本文と状態を保存し、送信結果を notification_logs に保存する
 *
 * 上限の判定は claim_line_quota()（DB側）が原子的に行う。
 * アプリ側で「数えて→判定して→送る」と書くと、同時リクエストで上限を超える。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { fromPostgresError } from '@/lib/errors';
import { sendEmail, sendLine, type SendResult } from '@/lib/notify/send';
import { BODY_LIMIT, type NotificationType } from '@/lib/notify/templates';

/** LINE を使う余地がある通知種別（6-9「LINE通知は最重要通知に限定」）。 */
const LINE_ELIGIBLE: readonly NotificationType[] = ['overdue', 'needs_fix'];

export interface NotificationRow {
  id: string;
  venue_id: string;
  case_id: string | null;
  recipient_user_id: string;
  channel: 'line' | 'email' | 'in_app';
  notification_type: NotificationType;
  title: string;
  body: string;
  status: string;
}

interface RecipientRow {
  id: string;
  email: string;
  line_user_id: string | null;
  status: string;
}

export type ResolvedChannel = 'line' | 'email' | 'in_app';

export interface DispatchResult {
  notificationId: string;
  channel: ResolvedChannel;
  delivered: boolean;
  /** LINE から切り替えた場合の理由。切替はログに残す（6-9） */
  switchedFrom?: 'line';
  reason?: string;
}

/**
 * 送信チャネルを決める（6-9）。
 *
 * in_app はそもそも外部送信を伴わないのでそのまま。
 * line は「紐付け済み」かつ「最重要通知」かつ「上限内」の3つが揃ったときだけ選ばれ、
 * どれかが欠ければメールへ落ちる。落とす先をメールに固定しているのは、
 * 「LINE送信不可のみで通知自体を落とさない」（6-9）ため。
 */
async function resolveChannel(
  client: SupabaseClient,
  notification: NotificationRow,
  recipient: RecipientRow,
): Promise<{ channel: ResolvedChannel; switchedFrom?: 'line'; reason?: string }> {
  if (notification.channel === 'in_app') return { channel: 'in_app' };

  if (notification.channel !== 'line') return { channel: 'email' };

  if (!recipient.line_user_id) {
    return { channel: 'email', switchedFrom: 'line', reason: 'LINE未紐付け' };
  }
  if (!LINE_ELIGIBLE.includes(notification.notification_type)) {
    return { channel: 'email', switchedFrom: 'line', reason: 'LINEは重要通知に限定' };
  }
  if (!notification.case_id) {
    // 案件に紐づかないシステム通知は案件×週の枠を数えられない
    return { channel: 'email', switchedFrom: 'line', reason: '案件に紐づかない通知' };
  }

  const { data, error } = await client.rpc('claim_line_quota', {
    p_case_id: notification.case_id,
    p_venue_id: notification.venue_id,
  });
  if (error) throw fromPostgresError(error);

  return data === true
    ? { channel: 'line' }
    : { channel: 'email', switchedFrom: 'line', reason: 'LINE送信上限に到達' };
}

/** 送信結果を notification_logs に残す（6-9）。 */
async function recordLog(
  client: SupabaseClient,
  notificationId: string,
  provider: 'line' | 'email',
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
    .select('id, email, line_user_id, status')
    .eq('id', notification.recipient_user_id)
    .maybeSingle();
  if (recipientResult.error) throw fromPostgresError(recipientResult.error);
  const recipient = recipientResult.data as RecipientRow | null;

  // 停止・削除された利用者には送らない。宛先が無いのに送信を試みると
  // Resend 側でバウンスし、送信ドメインの評価を下げる。
  if (!recipient || recipient.status !== 'active') {
    await client.from('notifications')
      .update({ status: 'cancelled' })
      .eq('id', notification.id);
    return { notificationId: notification.id, channel: 'in_app', delivered: false,
      reason: '宛先の利用者が有効ではありません' };
  }

  const resolved = await resolveChannel(client, notification, recipient);

  // マイページ内通知は外部送信を伴わない。保存した時点で届いている。
  if (resolved.channel === 'in_app') {
    await client.from('notifications')
      .update({ status: 'sent', sent_at: new Date().toISOString(), channel: 'in_app' })
      .eq('id', notification.id);
    return { notificationId: notification.id, channel: 'in_app', delivered: true };
  }

  // LINE は文字数上限が短い（付録D）。切り詰めてでも送る方が、
  // 送らずに落とすより通知の目的に適う。
  const limit = BODY_LIMIT[notification.notification_type];
  const body = resolved.channel === 'line' && notification.body.length > limit.line
    ? `${notification.body.slice(0, limit.line - 1)}…`
    : notification.body;

  const result = resolved.channel === 'line'
    ? await sendLine(recipient.line_user_id as string, body)
    : await sendEmail(recipient.email, notification.title, body);

  await client.from('notifications').update({
    // 実際に使ったチャネルへ書き換える。切替の事実が notifications 側にも残る（6-9）
    channel: resolved.channel,
    status: result.delivered ? 'sent' : 'failed',
    sent_at: result.delivered ? new Date().toISOString() : null,
  }).eq('id', notification.id);

  await recordLog(client, notification.id, resolved.channel, result, 1);

  return {
    notificationId: notification.id,
    channel: resolved.channel,
    delivered: result.delivered,
    switchedFrom: resolved.switchedFrom,
    reason: resolved.reason ?? result.reason ?? result.skippedReason,
  };
}
