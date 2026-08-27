/**
 * 招待URL・通知の外部送信（Resend／LINE Messaging API）。
 *
 * 正本: 基本設計書 Version 1.2 6-9「業務ロジック：通知」／6-10「LINE連携設計」／13-1。
 *
 * 【Phase 1 の扱い】
 * 13-1 の開発チーム決定により、Phase 1 の開発・ステージングでは Resend のテストドメインと
 * 開発者宛の送信に限定し、外部宛の送信はドメイン設定の完了を条件とする。
 * したがって環境変数が未設定の環境では「送信をスキップして送信操作自体は成功扱いにする」。
 * 例外を投げて画面を止めると、招待URLの発行（＝平文を1度だけ返す操作）まで巻き戻ってしまい、
 * URLを失うほうが業務上の損失が大きいため（6-3-6）。
 * 呼び出し側は delivered を見て「送信済み」と「未送信（発行のみ）」を画面で描き分ける。
 */
import type { ContactChannel } from '@/lib/constants';

export interface SendResult {
  /** 実際に外部サービスへ送信できたか。false なら未構成・宛先不明でスキップした */
  delivered: boolean;
  /** delivered=false のときに画面へ出す理由。利用者に見せる日本語 */
  skippedReason?: string;
}

export interface InvitationMessage {
  caseCode: string;
  /** 宛名。復号済みの氏名 */
  recipientName: string;
  invitationUrl: string;
  /** 有効期限（表示用の ISO 文字列） */
  expiresAt: string;
}

/** 送信本文。文言は圧迫感を与えない表現にする（要件 8 ユーザビリティ）。 */
function buildBody(message: InvitationMessage): string {
  return [
    `${message.recipientName} 様`,
    '',
    'ご結婚おめでとうございます。',
    '準備の進み具合を確認できるマイページをご用意しました。',
    '下のURLからご登録をお願いします。',
    '',
    message.invitationUrl,
    '',
    `※このURLの有効期限は ${message.expiresAt.slice(0, 10)} です。`,
    '※期限が切れた場合は、担当プランナーへお声がけいただければ再度お送りします。',
    '',
    `案件番号: ${message.caseCode}`,
  ].join('\n');
}

/** Resend でメール送信する。API キーが無い環境ではスキップする。 */
async function sendEmail(to: string, message: InvitationMessage): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    return { delivered: false, skippedReason: 'メール送信の設定が未構成のため、送信は行われていません' };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'マイページのご案内（結婚式の準備）',
      text: buildBody(message),
    }),
  });

  if (!response.ok) {
    // 本文にはトークンが含まれるためログへ残さない（9章）。状態コードのみ記録する。
    console.error('[notify] resend failed', response.status);
    return { delivered: false, skippedReason: 'メールの送信に失敗しました。時間をおいてお試しください' };
  }
  return { delivered: true };
}

/** LINE Messaging API のプッシュ送信。Phase 2 で本格運用する（6-10）。 */
async function sendLine(lineUserId: string, message: InvitationMessage): Promise<SendResult> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return { delivered: false, skippedReason: 'LINE連携が未構成のため、送信は行われていません' };
  }

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      to: lineUserId,
      messages: [{ type: 'text', text: buildBody(message) }],
    }),
  });

  if (!response.ok) {
    console.error('[notify] line push failed', response.status);
    return { delivered: false, skippedReason: 'LINEの送信に失敗しました。時間をおいてお試しください' };
  }
  return { delivered: true };
}

export interface InvitationTarget {
  /** 復号済みのメールアドレス。未登録なら null */
  email: string | null;
  /** 紐付け済みの LINE userId。未紐付けなら null */
  lineUserId: string | null;
}

/**
 * 招待URLを指定チャネルで送る。
 * 宛先が未登録の場合も例外にせず、理由付きでスキップを返す（発行済みURLを失わせないため）。
 */
export async function sendInvitation(
  channel: ContactChannel,
  target: InvitationTarget,
  message: InvitationMessage,
): Promise<SendResult> {
  if (channel === 'email') {
    if (!target.email) {
      return { delivered: false, skippedReason: '送信先のメールアドレスが登録されていません' };
    }
    return sendEmail(target.email, message);
  }

  if (!target.lineUserId) {
    // Phase 2 で M06 の紐付けが済むまでは常にこの経路になる（6-10）
    return { delivered: false, skippedReason: 'LINEの友だち追加がまだ行われていません' };
  }
  return sendLine(target.lineUserId, message);
}
