/**
 * GET/POST /api/venues — 式場および式場管理者アカウントの登録（表6-6、機能8-2、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 S02／表4-21／6-3-5 表6-4／5-7。
 *
 * 表6-4（v1.2 で追記）:
 *   「/api/venues（POST/PATCH。式場管理者の Auth ユーザー作成に Auth Admin API 利用）｜
 *     使用する｜呼び出し元JWTの role が system_admin であることを検証する。
 *     作成する user_profiles.role は 'admin' に固定し、venue_id は
 *     同一トランザクションで作成した式場に固定する。任意指定を受け付けない」
 *
 * 式場管理者にも初期パスワードは発行しない。U02 と同じく初回パスワード設定リンクを送る（6-3-1）。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { venueCreateSchema } from '@/lib/validation';
export const runtime = 'nodejs';
export const GET = route(async () => {
  const actor = await requireRole('system_admin');
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const { listVenuesAdmin } = await import('@/lib/d1/admin');
    const { rows } = await listVenuesAdmin(await localDB(), actor, 1);
    return ok({
      items: rows.map((v) => ({
        id: v.id,
        name: v.name,
        code: v.code,
        contact_email: v.contact_email,
        active: v.active,
        created_at: v.created_at,
      })),
    });
  }
});
export const POST = route(async (request: Request) => {
  const actor = await requireRole('system_admin');
  const input = await parseBody(request, venueCreateSchema);
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const { createVenueD1 } = await import('@/lib/d1/admin');
    const db = await localDB();
    const { id: venueId } = await createVenueD1(db, actor, {
      name: input.name,
      code: input.code,
      contactEmail: input.contactEmail ?? null,
      active: input.active,
    });
    if (!input.adminEmail || !input.adminName) return ok({ id: venueId, adminCreated: false }, 201);
    try {
      const { createStaff } = await import('@/lib/d1/staff');
      const created = await createStaff(db, actor, {
        displayName: input.adminName,
        email: input.adminEmail,
        venueId,
      } as never);
      return ok(
        { id: venueId, adminCreated: true, mailDelivered: created.mailDelivered, mailReason: null },
        201,
      );
    } catch {
      return ok(
        { id: venueId, adminCreated: false, reason: '式場管理者を作成できませんでした' },
        201,
      );
    }
  }
});
