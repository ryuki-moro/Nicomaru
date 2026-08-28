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
 *
 * 【送信口は1つ】
 * メールは mailer.ts の sendMail に委ねる。ここに Resend への POST を写して持っていた頃は
 * fetch の例外を握っておらず、上の方針とは逆に「送信の失敗で発行応答ごと 500」になっていた。
 * LINE も同じ形（未構成・HTTPエラー・例外の3経路を SendResult へ畳む）にそろえる。
 */
import type { ContactChannel } from '@/lib/constants';
import { sendMail, type SendResult } from '@/lib/notify/mailer';

// 結果の型は mailer.ts に1つだけ置く。呼び出し側が送信手段を意識せず使えるよう再公開する。
export type { SendResult };

/** LINE 送信の失敗時に画面へ出す文言。メール側は sendMail が同等の文言を返す。 */
const LINE_NOT_CONFIGURED = 'LINE連携が未構成のため、送信は行われていません';
const LINE_ERROR = 'LINEの送信に失敗しました。時間をおいてお試しください';

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

/**
 * 招待URLをメールで送る。
 * Resend への POST は mailer.ts の sendMail に一本化してあるので、ここは本文を組んで結果を写すだけ。
 * 未構成・HTTPエラー・例外はすべて sendMail が SendResult へ畳んで返す。
 */
export function sendEmail(to: string, subject: string, text: string): Promise<SendResult> {
  return sendMail({ to, subject, text });
}

/**
 * LINE Messaging API のプッシュ送信（6-10）。
 *
 * 招待URLの送付（Phase 1）と通知（Phase 2、7-1）の両方がここを通る。
 * 用途ごとに fetch を写して持つと、例外の扱いが片方だけ直る事故が起きる。
 */
export async function sendLine(lineUserId: string, text: string): Promise<SendResult> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return { delivered: false, reason: 'not_configured', skippedReason: LINE_NOT_CONFIGURED };
  }

  try {
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] }),
    });

    if (!response.ok) {
      // 本文にはトークンが含まれるためログへ残さない（9章）。状態コードのみ記録する。
      console.error('[notify] line push failed', response.status);
      return { delivered: false, reason: 'provider_error', skippedReason: LINE_ERROR };
    }
    return { delivered: true };
  } catch (error) {
    // 例外を素通しすると、招待の発行は成功しているのに 500 になり、
    // その応答でしか返らない平文の招待URLを失う（6-3-6）。送信失敗として畳む。
    console.error('[notify] line push threw', error);
    return { delivered: false, reason: 'provider_error', skippedReason: LINE_ERROR };
  }
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
      return {
        delivered: false,
        reason: 'not_configured',
        skippedReason: '送信先のメールアドレスが登録されていません',
      };
    }
    return sendEmail(target.email, 'マイページのご案内（結婚式の準備）', buildBody(message));
  }

  if (!target.lineUserId) {
    // Phase 2 で M06 の紐付けが済むまでは常にこの経路になる（6-10）
    return {
      delivered: false,
      reason: 'not_configured',
      skippedReason: 'LINEの友だち追加がまだ行われていません',
    };
  }
  return sendLine(target.lineUserId, buildBody(message));
}
