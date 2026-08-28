/**
 * 連絡履歴の自動記録（6-7）。
 *
 * 正本: 基本設計書 6-7「3・4・5 の各時点で communication_logs に自動記録する」。
 *
 * communication_logs は直接 insert させず log_communication() を通す。
 * created_by を引数で受け取らず関数内で auth.uid() から解決するため、実行者を偽装できない
 * （log_audit() と同じ考え方。20260828000900_submission_functions.sql）。
 *
 * 提出側と確認側にほぼ同じヘルパが2つあったのでここへ寄せた。
 * 記録する内容は違っても、「失敗しても業務処理は巻き戻さない」という扱いは同じで、
 * 片方だけ扱いを変えると連絡履歴の欠落条件が経路ごとに変わってしまう。
 */
import type { SupabaseServerClient } from '@/lib/supabase/server';

/** 5-3 communication_logs の値域。 */
export type CommunicationChannel = 'in_app' | 'line' | 'email' | 'phone' | 'meeting' | 'other';
export type CommunicationDirection = 'inbound' | 'outbound';

/**
 * 連絡履歴を1件残す。
 *
 * 連絡履歴は業務データの副次的な記録であって、提出・確認の結果そのものではない。
 * ここで失敗しても確定済みの処理を巻き戻さず、サーバーログにだけ残す。
 */
export async function logCommunication(
  supabase: SupabaseServerClient,
  input: {
    caseId: string;
    channel: CommunicationChannel;
    direction: CommunicationDirection;
    /** 5-3 の source。どの操作から起きた記録かを表す（submit／review など） */
    source: string;
    summary: string;
  },
): Promise<void> {
  const { error } = await supabase.rpc('log_communication', {
    p_case_id: input.caseId,
    p_channel: input.channel,
    p_direction: input.direction,
    p_source: input.source,
    p_summary: input.summary,
  });
  if (error) {
    console.warn(`[${input.source}] communication_logs に記録できませんでした`, error);
  }
}
