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

/** 5-3 communication_logs の値域。 */
export type CommunicationChannel = 'in_app' | 'line' | 'email' | 'phone' | 'meeting' | 'other';
export type CommunicationDirection = 'inbound' | 'outbound';
