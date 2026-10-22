/** 通知の送信権・固定ペイロード・結果保存はDBの原子的RPCで管理する。 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fromPostgresError } from '@/lib/errors';
import { sendEmail, sendLine } from '@/lib/notify/send';

export type ResolvedChannel = 'line' | 'email' | 'in_app';
export interface NotificationRow {
  id: string;
}
export interface DispatchResult {
  notificationId: string;
  channel: ResolvedChannel;
  /** 外部サービスの受付。到達・既読とは異なる。 */
  delivered: boolean;
  switchedFrom?: 'line';
  reason?: string;
  outcome?: string;
}
interface DeliveryClaim {
  notification_id: string;
  claim_token: string;
  retry_key: string;
  channel: ResolvedChannel;
  switch_reason: string | null;
  payload: { to: string; subject: string; text: string; from: string };
}

export async function dispatchNotification(
  client: SupabaseClient,
  notification: NotificationRow,
): Promise<DispatchResult> {
  const claimed = await client.rpc('claim_notification_delivery', {
    p_id: notification.id,
    p_email_from: process.env.RESEND_FROM ?? null,
    p_available_channels: [
      'in_app',
      ...(process.env.RESEND_API_KEY && process.env.RESEND_FROM ? ['email'] : []),
      ...(process.env.LINE_CHANNEL_ACCESS_TOKEN ? ['line'] : []),
    ],
  });
  if (claimed.error) throw fromPostgresError(claimed.error);
  const claim = claimed.data?.[0] as DeliveryClaim | undefined;
  if (!claim) {
    const current = await client
      .from('notification_deliveries')
      .select('state,channel,last_result')
      .eq('notification_id', notification.id)
      .maybeSingle();
    if (current.error) throw fromPostgresError(current.error);
    return {
      notificationId: notification.id,
      channel: (current.data?.channel ?? 'in_app') as ResolvedChannel,
      delivered: current.data?.state === 'sent',
      outcome: current.data?.state === 'sent' ? 'accepted' : 'not_claimed',
      reason:
        current.data?.state === 'sent'
          ? undefined
          : '送信待ち・処理中または要確認です。通知履歴を確認してください',
    };
  }
  const options = { idempotencyKey: claim.retry_key, from: claim.payload.from };
  const result =
    claim.channel === 'in_app'
      ? { delivered: true, outcome: 'accepted' as const }
      : claim.channel === 'line'
        ? await sendLine(claim.payload.to, claim.payload.text, options)
        : await sendEmail(claim.payload.to, claim.payload.subject, claim.payload.text, options);
  const outcome = result.outcome ?? (result.delivered ? 'accepted' : 'unknown');
  const saved = await client.rpc('finish_notification_delivery', {
    p_id: notification.id,
    p_claim_token: claim.claim_token,
    p_result: outcome,
    p_provider_id: 'providerMessageId' in result ? (result.providerMessageId ?? null) : null,
  });
  if (saved.error || saved.data !== true) {
    // ペイロードや宛先は出さず、監視から照合できる識別子だけを残す。
    console.error('[notify] 送信結果の保存を確認できません', { notificationId: notification.id });
    throw new Error('通知の送信結果を保存できませんでした');
  }
  return {
    notificationId: notification.id,
    channel: claim.channel,
    delivered: result.delivered,
    outcome,
    switchedFrom: claim.switch_reason ? 'line' : undefined,
    reason: claim.switch_reason ?? ('skippedReason' in result ? result.skippedReason : undefined),
  };
}

/** 次回試行日時・UUIDのカーソルで走査し、古い未処理分から継続する。 */
export async function dispatchPendingNotifications(client: SupabaseClient, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs;
  const cutoff = new Date().toISOString();
  let cursor: { notification_id: string; next_attempt_at: string } | undefined;
  let sent = 0,
    failed = 0,
    skipped = 0;
  do {
    const lease = `lease_until.is.null,lease_until.lte.${new Date().toISOString()}`;
    const query = client
      .from('notification_deliveries')
      .select('notification_id,next_attempt_at')
      .in('state', ['pending', 'retry', 'processing'])
      .lte('next_attempt_at', cutoff)
      .or(
        cursor
          ? `and(or(${lease}),or(next_attempt_at.gt.${cursor.next_attempt_at},and(next_attempt_at.eq.${cursor.next_attempt_at},notification_id.gt.${cursor.notification_id})))`
          : lease,
      )
      .order('next_attempt_at')
      .order('notification_id')
      .limit(500);
    const page = await query;
    if (page.error) throw fromPostgresError(page.error);
    const rows = (page.data ?? []) as { notification_id: string; next_attempt_at: string }[];
    for (const row of rows) {
      if (Date.now() >= deadline) return { sent, failed, skipped, deferred: true };
      try {
        const result = await dispatchNotification(client, { id: row.notification_id });
        if (result.delivered) sent++;
        else if (result.outcome === 'not_claimed') skipped++;
        else failed++;
      } catch {
        failed++;
      }
      cursor = row;
    }
    if (rows.length < 500) break;
  } while (Date.now() < deadline);
  return { sent, failed, skipped, deferred: Date.now() >= deadline };
}
