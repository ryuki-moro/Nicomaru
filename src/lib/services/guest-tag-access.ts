/**
 * ゲストの自由タグを変更するAPIで共有する前提チェック。
 *
 * 誰が触れるかは RLS（case_guest_tags_all）が決める。ここで見るのは、
 * RLS では表せない「アーカイブ済みの案件は変更しない」という業務ルールだけ
 * （admin はアーカイブ済みの案件も参照できるため、RLS だけでは書き込みが通ってしまう）。
 */
import { fromPostgresError, notFound, unprocessable } from '@/lib/errors';
import type { SupabaseServerClient } from '@/lib/supabase/server';

export async function assertGuestTagsEditable(
  supabase: SupabaseServerClient,
  caseId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('wedding_cases')
    .select('id, archived_at')
    .eq('id', caseId)
    .maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw notFound('案件が見つかりません');
  if (data.archived_at) throw unprocessable('アーカイブ済みの案件のタグは変更できません');
}
