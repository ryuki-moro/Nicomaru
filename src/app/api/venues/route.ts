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
import { ROLE_LABEL } from '@/lib/constants';
import { conflict, fromPostgresError } from '@/lib/errors';
import { issuePasswordSetupLink, sendPasswordSetupMail } from '@/lib/notify/mailer';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { venueCreateSchema } from '@/lib/validation';

export const runtime = 'nodejs';

export const GET = route(async () => {
  await requireRole('system_admin');
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('venues')
    .select('id, name, code, contact_email, active, created_at')
    .order('code', { ascending: true });
  if (error) throw fromPostgresError(error);

  return ok({ items: data ?? [] });
});

export const POST = route(async (request: Request) => {
  await requireRole('system_admin');
  const input = await parseBody(request, venueCreateSchema);

  // 式場そのものは RLS 経由で作る（venues_write は system_admin のみ）。
  // API 層にバグがあっても RLS が最終防衛線として働く（6-3-5）。
  const supabase = await createSupabaseServerClient();
  const venue = await supabase
    .from('venues')
    .insert({
      name: input.name,
      code: input.code,
      contact_email: input.contactEmail ?? null,
      active: input.active,
    })
    .select('id, code')
    .single();
  if (venue.error) {
    // 5-7「重複時は画面で入力エラー（409）」
    throw venue.error.code === '23505' ? conflict('その式場コードは既に使われています')
      : fromPostgresError(venue.error);
  }
  const venueId = (venue.data as { id: string }).id;

  // 管理者アカウントは任意。指定が無ければ式場だけ作る（後から U02 で追加できる）。
  if (!input.adminEmail || !input.adminName) {
    return ok({ id: venueId, adminCreated: false }, 201);
  }

  // 他人の Auth ユーザーを作るため Service Role が要る（表6-4）。
  // U02 と同じく、初期パスワードは発行せず generateLink(invite) で
  // Auth ユーザーの作成と初回設定リンクの発行を同時に行う（6-3-1）。
  const admin = createSupabaseAdminClient('admin.venues');
  const issued = await issuePasswordSetupLink(admin, { email: input.adminEmail });
  if (!issued.ok) {
    // 式場だけ残っても S02 から管理者を追加できるので、式場は巻き戻さない。
    // 画面には理由を返して、管理者だけ作り直せるようにする。
    return ok({
      id: venueId,
      adminCreated: false,
      reason: issued.reason === 'already_registered'
        ? 'このメールアドレスは既に登録されています'
        : '初回パスワード設定リンクを発行できませんでした',
    }, 201);
  }

  const profile = await admin.from('user_profiles').insert({
    auth_user_id: issued.authUserId,
    venue_id: venueId,
    // role は 'admin' に固定。任意指定を受け付けない（表6-4）
    role: 'admin',
    display_name: input.adminName,
    email: input.adminEmail,
    // 初回パスワード設定が済むまではログインできない（6-3-1）
    status: 'invited',
  }).select('id').single();

  if (profile.error) {
    // 孤児の Auth ユーザーはそのメールを永久に登録不能にするため必ず巻き戻す
    await admin.auth.admin.deleteUser(issued.authUserId);
    throw fromPostgresError(profile.error);
  }

  const mail = await sendPasswordSetupMail({
    to: input.adminEmail,
    displayName: input.adminName,
    roleLabel: ROLE_LABEL.admin,
    venueName: input.name,
    actionLink: issued.actionLink,
  });

  return ok({
    id: venueId,
    adminCreated: true,
    // 13-1: 検証段階では未送信になりうるので画面へ理由を返す
    mailDelivered: mail.delivered,
    mailReason: mail.skippedReason ?? null,
  }, 201);
});
