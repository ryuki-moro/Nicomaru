/**
 * GET /api/ai/status — AI補助が使える状態かを返す（表6-6、Phase 3）。
 *
 * 正本: 基本設計書 7-1／7-3 (4)。
 *
 *   「LLMサーバー停止時は該当機能を『利用不可』と表示し、手動運用にフォールバックする
 *     （他機能の利用に影響を与えない）」
 *   「7-1 の『利用不可』表示は、最終ポーリングから10分以上経過したことを判定条件とする」
 *
 * 画面（Server Component）は fetchAiAssistStatus() を直接呼べるので、
 * このAPIは「依頼ボタンを押す前にクライアント側で状態を取り直す」用途に絞る。
 * 判定そのものは DB 関数 ai_assist_status() が持つ（10分の閾値を画面ごとに書かない）。
 */
import { ok, route } from '@/lib/api/route';
import { fetchAiAssistStatus } from '@/lib/ai/assist';
import { requireAppUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = route(async () => {
  // couple も 9-7（Phase 3拡張）で使うため staff に限定しない。
  // 返すのは可否と最終心拍だけで、案件データは含まない。
  await requireAppUser();

  const supabase = await createSupabaseServerClient();
  const status = await fetchAiAssistStatus(supabase);

  return ok({ available: status.available, lastSeenAt: status.lastSeenAt });
});
