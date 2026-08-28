/**
 * POST /api/notifications/send — 重要通知の送信（表6-6、機能7-1、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-9／付録D。
 *
 * プランナーが明示的に送る経路。作成は create_notification()（権限と宛先を関数側で検証）、
 * 送信はチャネル解決・上限判定・ログ記録を含むサービスに委ねる。
 *
 * 文面は付録D のテンプレートから組み立てる。自由文を直接送らせないのは、
 * 第11章「通知文面レビュー」が求める文面の統制を、送信経路の側で担保するため。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireStaff } from '@/lib/auth/session';
import { COUPLE_PROFILE_COLUMNS } from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { badRequest, fromPostgresError, notFound } from '@/lib/errors';
import { checkNotificationText, renderNotification } from '@/lib/notify/templates';
import { dispatchNotification, type NotificationRow } from '@/lib/services/notifications';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { notificationSendSchema } from '@/lib/validation';

export const runtime = 'nodejs';

export const POST = route(async (request: Request) => {
  const user = await requireStaff();
  const input = await parseBody(request, notificationSendSchema);
  const supabase = await createSupabaseServerClient();

  // 宛名（新郎新婦名）は暗号化列。RLS 経由で取得する。
  const profile = await supabase
    .from('couple_profiles')
    .select(COUPLE_PROFILE_COLUMNS)
    .eq('case_id', input.caseId)
    .eq('user_profile_id', input.recipientUserId)
    .maybeSingle();
  if (profile.error) throw fromPostgresError(profile.error);
  if (!profile.data) throw notFound('宛先が見つかりません');

  const rendered = renderNotification(input.notificationType, {
    coupleName: readPii((profile.data as unknown as { full_name: string }).full_name),
    plannerName: user.displayName,
    taskName: input.taskName ?? undefined,
    dueDate: input.dueDate ?? undefined,
    reviewComment: input.comment ?? undefined,
    subject: input.subject ?? undefined,
    message: input.message ?? undefined,
  });

  // 付録D の表現基準に反する文面は送らない。目視レビュー（11章）の前段のふるい。
  const check = checkNotificationText(rendered.body);
  if (!check.ok) {
    throw badRequest(
      check.violations.map((v) => ({ field: 'message', reason: `${v.reason}（「${v.matched}」）` })),
      '通知文面に見直したい表現があります',
    );
  }

  const created = await supabase.rpc('create_notification', {
    p_case_id: input.caseId,
    p_recipient_user_id: input.recipientUserId,
    p_channel: input.channel,
    p_notification_type: input.notificationType,
    p_title: rendered.title,
    p_body: rendered.body,
  });
  if (created.error) throw fromPostgresError(created.error);

  // 送信は notifications.status の更新と notification_logs への書き込みを伴う。
  // どちらも authenticated には開いていないため（付録A）、内部処理として実行する（表6-4）。
  const admin = createSupabaseAdminClient('cron.notifications-dispatch');
  const row = await admin
    .from('notifications')
    .select('id, venue_id, case_id, recipient_user_id, channel, notification_type, title, body, status')
    .eq('id', created.data as string)
    .single();
  if (row.error) throw fromPostgresError(row.error);

  const result = await dispatchNotification(admin, row.data as unknown as NotificationRow);

  return ok({
    notificationId: result.notificationId,
    channel: result.channel,
    delivered: result.delivered,
    // 6-9「上限到達時はメールへ切り替えて送信し、切替をログに残す」。画面にも理由を出す
    switchedFrom: result.switchedFrom ?? null,
    reason: result.reason ?? null,
  }, 201);
});
