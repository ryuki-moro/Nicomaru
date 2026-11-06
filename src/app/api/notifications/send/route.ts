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
import { notificationSendSchema } from '@/lib/validation';
export const runtime = 'nodejs';
export const POST = route(async (request: Request) => {
  const user = await requireStaff();
  const input = await parseBody(request, notificationSendSchema);
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const { createNotification } = await import('@/lib/d1/notifications');
    return ok(await createNotification(await localDB(), user, input), 201);
  }
});
