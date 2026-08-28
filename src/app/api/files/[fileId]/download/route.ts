/**
 * GET /api/files/{fileId}/download — 提出ファイル・生成PDFの短命署名付きURL発行（6-5 表6-6）。
 *
 * 表6-6 の認証欄:「storage_files を RLS 経由で取得できること＋visibility 判定の両方を満たすこと」。
 *   1. RLS 適用クライアントで storage_files を引く（引けない＝範囲外なので 404）
 *   2. そのうえで visibility を API 層でも判定する（6-11）
 * Service Role は使わない。表6-4 に本用途の行が無く、
 * RLS を迂回した瞬間に 1 の条件が形骸化するため（6-3-5）。
 */
import { requireAppUser } from '@/lib/auth/session';
import { ok, route } from '@/lib/api/route';
import { isStaff } from '@/lib/constants';
import { ApiError, forbidden, fromPostgresError, notFound } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isUuid } from '@/lib/uuid';


/** 表6-6:「TTL 60秒、都度発行」。URL を画面に焼き込まないための短さなので延ばさない。 */
const SIGNED_URL_TTL_SECONDS = 60;

interface StorageFileRow {
  id: string;
  bucket: string;
  object_path: string;
  original_filename: string | null;
  visibility: 'case_private' | 'planner_only' | 'system';
}

export const GET = route(
  async (_request: Request, context: { params: Promise<{ fileId: string }> }) => {
    const { fileId } = await context.params;
    const user = await requireAppUser();
    if (!isUuid(fileId)) throw notFound();

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from('storage_files')
      .select('id, bucket, object_path, original_filename, visibility')
      .eq('id', fileId)
      .maybeSingle();
    if (error) throw fromPostgresError(error);
    if (!data) throw notFound();

    const file = data as unknown as StorageFileRow;

    // planner_only は restrictive ポリシーで couple から既に隠れているが、
    // system（バッチ生成物）は隠れていない。表6-6 の「visibility 判定」を API 層でも独立に行う。
    if (file.visibility !== 'case_private' && !isStaff(user.role)) throw forbidden();

    const { data: signed, error: signError } = await supabase.storage
      .from(file.bucket)
      .createSignedUrl(file.object_path, SIGNED_URL_TTL_SECONDS);
    if (signError || !signed) {
      // bucket 側の権限不足・実体欠落など。内部事情はクライアントへ返さない（10章）
      console.error('[files] 署名付きURLの発行に失敗しました', signError);
      throw new ApiError('INTERNAL_ERROR', 'ファイルを取得できませんでした');
    }

    return ok({
      url: signed.signedUrl,
      fileName: file.original_filename,
      expiresIn: SIGNED_URL_TTL_SECONDS,
    });
  },
);
