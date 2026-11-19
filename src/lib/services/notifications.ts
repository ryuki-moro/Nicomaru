/**
 * 通知の送信（Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-9「業務ロジック：通知」／7-1〜7-3／付録D。
 *
 * LINE連携は終了した。旧データで channel='line' の通知はメールへ切り替え、
 * 切替の事実を notifications と notification_logs に残す（通知自体は落とさない）。
 * 送信時は notifications に本文と状態を保存し、送信結果を notification_logs に保存する。
 */

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
