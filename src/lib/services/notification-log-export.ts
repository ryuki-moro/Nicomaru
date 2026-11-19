/** S03 の通知ログCSV。RLS適用クライアントで最大10,001件を取得する（#45）。 */
import type { NotificationType } from '@/lib/notify/templates';

export interface NotificationLogExportRow {
  id: string;
  provider: 'line' | 'email';
  status: 'success' | 'failure';
  provider_message_id: string | null;
  created_at: string;
  notifications: {
    notification_type: NotificationType;
    venues: { name: string } | null;
    wedding_cases: { case_code: string } | null;
  } | null;
}
