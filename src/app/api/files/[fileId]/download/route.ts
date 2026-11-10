/**
 * GET /api/files/{fileId}/download — 提出ファイル・生成PDFの短命署名付きURL発行（6-5 表6-6）。
 *
 * 表6-6 の認証欄:「storage_files を RLS 経由で取得できること＋visibility 判定の両方を満たすこと」。
 *   1. RLS 適用クライアントで storage_files を引く（引けない＝範囲外なので 404）
 *   2. そのうえで visibility を API 層でも判定する（6-11）
 * Service Role は使わない。表6-4 に本用途の行が無く、
 * RLS を迂回した瞬間に 1 の条件が形骸化するため（6-3-5）。
 */
import { route } from '@/lib/api/route';
import { requireAppUser } from '@/lib/auth/session';
import { notFound } from '@/lib/errors';
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
  async (
    _request: Request,
    context: {
      params: Promise<{
        fileId: string;
      }>;
    },
  ) => {
    const { fileId } = await context.params;
    const user = await requireAppUser();
    if (!isUuid(fileId)) throw notFound();
    {
      const { localDB, localFiles } = await import('@/lib/d1/runtime');
      const { downloadFile } = await import('@/lib/d1/files');
      return downloadFile(
        await localDB(),
        await localFiles(),
        user,
        fileId,
        new URL(_request.url).searchParams.get('raw') === '1',
      );
    }
  },
);
