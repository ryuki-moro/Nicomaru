/**
 * PATCH  /api/cases/{caseId}/seating-layouts/{layoutId} — 配置パターンを保存する／新郎新婦へ送る・送るのをやめる
 * DELETE /api/cases/{caseId}/seating-layouts/{layoutId} — 配置パターンを削除する
 *
 * PATCH の本文が { offered } なら送付の切り替え、それ以外は名前・会場の形・卓の全件の保存。
 */
import { noContent, ok, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { badRequest, fromPostgresError, notFound } from '@/lib/errors';
import { createSupabaseServerClient, type SupabaseServerClient } from '@/lib/supabase/server';
import { seatingLayoutOfferSchema, seatingLayoutSchema, toErrorDetails } from '@/lib/validation';

type Context = { params: Promise<{ caseId: string; layoutId: string }> };

/** layoutId がこの案件の配置パターンであることを確かめる */
async function assertLayoutInCase(
  supabase: SupabaseServerClient,
  caseId: string,
  layoutId: string,
) {
  const { data, error } = await supabase
    .from('seating_layouts')
    .select('id')
    .eq('id', layoutId)
    .eq('case_id', caseId)
    .maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw notFound('配置パターンが見つかりません');
}

export const PATCH = route(async (request: Request, context: Context) => {
  await requireRole('planner', 'admin', 'system_admin');
  const { caseId, layoutId } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest([{ field: '_', reason: 'リクエストの形式が正しくありません' }]);
  }

  const offer = seatingLayoutOfferSchema.safeParse(raw);
  const save = offer.success ? null : seatingLayoutSchema.safeParse(raw);
  if (!offer.success && !save?.success) {
    // 送付の切り替えを意図した本文（offered を含む）ならそちらの不備として返す
    const isOffer = typeof raw === 'object' && raw !== null && 'offered' in raw;
    throw badRequest(toErrorDetails(isOffer ? offer.error : save!.error!));
  }

  const supabase = await createSupabaseServerClient();
  await assertLayoutInCase(supabase, caseId, layoutId);

  if (offer.success) {
    const { error } = await supabase.rpc('set_seating_layout_offered', {
      p_layout_id: layoutId,
      p_offered: offer.data.offered,
    });
    if (error) throw fromPostgresError(error);
    return ok({ id: layoutId });
  }

  const input = save!.data!;
  const { data, error } = await supabase.rpc('save_seating_layout', {
    p_case_id: caseId,
    p_layout_id: layoutId,
    p_name: input.name,
    p_hall_shape: input.hallShape,
    p_tables: input.tables,
  });
  if (error) throw fromPostgresError(error);
  return ok({ id: (data as string | null) ?? layoutId });
});

export const DELETE = route(async (_request: Request, context: Context) => {
  await requireRole('planner', 'admin', 'system_admin');
  const { caseId, layoutId } = await context.params;
  const supabase = await createSupabaseServerClient();
  await assertLayoutInCase(supabase, caseId, layoutId);

  const { error } = await supabase.rpc('delete_seating_layout', { p_layout_id: layoutId });
  if (error) throw fromPostgresError(error);
  return noContent();
});
