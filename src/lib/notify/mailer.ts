/**
 * メール送信（Gmail SMTP／Resend）と、初回パスワード設定リンクの発行・送信。
 *
 * 正本: 基本設計書 Version 1.2 6-2 表6-1（外部連携）／6-3-1（初回パスワード設定リンク）／13-1。
 *
 * 【なぜリンク発行と送信を同じモジュールに置くか】
 * 6-3-1 の「初期パスワードを発行せず、Resend 経由の設定リンクを送る」は発行と送信が対で
 * はじめて成立する（発行だけしてメールが出ないと、その利用者は永久にログインできない）。
 * 呼び出し側で分離できるようにすると片方だけ実装される事故が起きるため、一組で公開する。
 *
 * 【なぜ SDK を使わず fetch で叩くか】
 * 使うのは Resend の 1 エンドポイントだけで、依存を増やしても得るものが無い。
 *
 * 【Gmail SMTP を優先する理由】
 * Resend は独自ドメインを認証するまで登録者本人にしか届かない。ドメインを持たない間は
 * GMAIL_USER／GMAIL_APP_PASSWORD（アプリパスワード）が揃っていれば smtp.gmail.com:465 から送る。
 * worker-mailer は cloudflare:sockets を使い OpenNext の束ねを通らないため、
 * 本番Workerの入口（cloudflare/app-worker.mjs）が読み込んで globalThis.__workerMailer に置く。
 *
 * 【送信設定が無い環境】
 * 13-1 の決定により、Phase 1 の開発段階は「開発者宛送信で検証できる段階」を設ける。
 * キー未設定のときは送信せず、宛先・件名・本文をサーバーログへ出して処理を続行する。
 * 送信できなかった事実は SendResult で呼び出し元へ返し、画面に注意文として表示させる。
 * 設定リンクを含む本文をログへ出すのはキー未設定のローカル開発時に限られる（本番では
 * キーが必ず設定されるため到達しない）。
 *
 * 【Resend への POST はこの1箇所だけ】
 * 招待送信（notify/send.ts）にも同じ POST があったが、そちらは fetch の例外を握っておらず、
 * DNS障害やタイムアウトで例外が上がると POST /api/cases/{caseId}/invitations が 500 になり、
 * その応答でしか返らない平文の招待URLを失っていた（6-3-6）。
 * 未構成・HTTPエラー・例外の3経路の扱いを1箇所に保つため、送信口を sendMail に統合する。
 */

import { INVITE_LINK_TTL_HOURS, PASSWORD_MIN_LENGTH } from '@/lib/constants';
import type * as WorkerMailerModule from 'worker-mailer';

declare global {
  var __workerMailer: typeof WorkerMailerModule | undefined;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * 外部送信（メール・LINE）の結果。送信手段によらずこの1つを使う。
 *
 * かつては mailer.ts の MailResult と notify/send.ts の SendResult に分かれており、
 * 同じ「送れたか・送れなかった理由は何か」を二重に定義していた。
 * 直和型にすると呼び出し側が delivered で絞り込まないと理由を読めず、
 * 「発行は成功・送信だけ未了」を1つの応答へ詰める招待APIで扱いにくいため、
 * 平坦な形にして delivered=false のときだけ理由が付く約束にする。
 */
export interface SendResult {
  /** 実際に外部サービスへ送信できたか。false なら未構成・宛先不明・送信失敗 */
  delivered: boolean;
  /** 失敗の種別。画面文言ではなく分岐・記録のための機械的な値 */
  reason?: 'not_configured' | 'provider_error';
  /** delivered=false のときに画面へ出す理由。利用者に見せる日本語 */
  skippedReason?: string;
  /** 送信できたときのプロバイダ側ID。障害時の突き合わせに使う */
  providerMessageId?: string | null;
}

const NOT_CONFIGURED_MESSAGE = 'メール送信の設定が未構成のため、送信は行われていません';
const PROVIDER_ERROR_MESSAGE = 'メールの送信に失敗しました。時間をおいてお試しください';

/** 招待URL・通知URLの生成に使う（表12-2 APP_BASE_URL）。 */
export function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? 'http://localhost:3000';
}

async function sendViaGmail(
  message: MailMessage,
  user: string,
  password: string,
): Promise<SendResult> {
  const mailer = globalThis.__workerMailer;
  if (!mailer) {
    console.error('[mail] Gmail SMTP は本番Workerの入口でのみ使えます（worker-mailer 未読込）');
    return { delivered: false, reason: 'provider_error', skippedReason: PROVIDER_ERROR_MESSAGE };
  }
  const { WorkerMailer, LogLevel } = mailer;
  let connection: WorkerMailerModule.WorkerMailer | undefined;
  try {
    // 静的な WorkerMailer.send は送信失敗時に close せず接続を残すため、接続を持って閉じる。
    connection = await WorkerMailer.connect({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      credentials: { username: user, password },
      authType: 'plain',
      // 既定の INFO は SMTP の往復（宛先を含む）をログへ出すため止める（9章）。
      logLevel: LogLevel.NONE,
      socketTimeoutMs: 10_000,
      responseTimeoutMs: 10_000,
    });
    await connection.send({
      from: { name: process.env.MAIL_FROM_NAME ?? 'Bellink', email: user },
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return { delivered: true, providerMessageId: null };
  } catch (error) {
    console.error('[mail] Gmail SMTP での送信に失敗しました', error);
    return { delivered: false, reason: 'provider_error', skippedReason: PROVIDER_ERROR_MESSAGE };
  } finally {
    await connection?.close().catch(() => {});
  }
}

export async function sendMail(message: MailMessage): Promise<SendResult> {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPassword = process.env.GMAIL_APP_PASSWORD;
  if (gmailUser && gmailPassword) return sendViaGmail(message, gmailUser, gmailPassword);

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;

  if (!apiKey || !from) {
    console.info(
      '[mail] GMAIL_USER／GMAIL_APP_PASSWORD と RESEND_API_KEY／RESEND_FROM が未設定のため送信をスキップしました（13-1 開発者宛検証段階）\n' +
        `  to: ${message.to}\n  subject: ${message.subject}\n${message.text}`,
    );
    return { delivered: false, reason: 'not_configured', skippedReason: NOT_CONFIGURED_MESSAGE };
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });

    if (!response.ok) {
      // 本文には宛先が含まれるため、詳細はサーバーログにのみ残す（9章）
      console.error('[mail] 送信に失敗しました', response.status, await response.text());
      return { delivered: false, reason: 'provider_error', skippedReason: PROVIDER_ERROR_MESSAGE };
    }

    // 送信自体は成功している。応答本文の解釈に失敗しても「送れなかった」と誤って伝えない。
    const body = (await response.json().catch(() => ({}))) as { id?: string };
    return { delivered: true, providerMessageId: body.id ?? null };
  } catch (error) {
    // fetch は DNS障害・タイムアウト・接続断で例外になる。ここで throw すると
    // 呼び出し元（招待URLの発行応答など）ごと 500 になり、発行済みの平文URLを失う（6-3-6）。
    console.error('[mail] 送信要求が例外で終了しました', error);
    return { delivered: false, reason: 'provider_error', skippedReason: PROVIDER_ERROR_MESSAGE };
  }
}

// ------------------------------------------ 初回パスワード設定リンク（6-3-1／U02・U03）

export type IssueLinkResult =
  | { ok: true; authUserId: string; actionLink: string }
  | { ok: false; reason: 'already_registered' | 'provider_error'; detail?: string };

/** 初回パスワード設定リンクの本文（U02／U03）。圧迫感を与えない案内文にする（要件 8）。 */
export function sendPasswordSetupMail(params: PasswordSetupMailParams): Promise<SendResult> {
  return sendMail(passwordSetupMessage(params));
}

interface PasswordSetupMailParams {
  to: string;
  displayName: string;
  roleLabel: string;
  venueName?: string | null;
  actionLink: string;
  isResend?: boolean;
}

export function passwordSetupMessage(params: PasswordSetupMailParams): MailMessage {
  const belongs = params.venueName ? `${params.venueName}の` : '';
  const subject = params.isResend
    ? '【Bellink】パスワード設定リンクの再送のご案内'
    : '【Bellink】アカウント登録のご案内';

  const text = [
    `${params.displayName} 様`,
    '',
    `${belongs}Bellink（ベリンク）に、${params.roleLabel}としてのアカウントをご用意しました。`,
    '下のリンクから、ご自身でパスワードを設定してご利用を開始してください。',
    '',
    params.actionLink,
    '',
    `・リンクの有効期限は約${INVITE_LINK_TTL_HOURS}時間です。`,
    `・パスワードは${PASSWORD_MIN_LENGTH}文字以上で設定してください。`,
    '・期限が切れた場合は、式場の管理者に再送を依頼してください。',
    '',
    'お心当たりのない場合は、このメールは破棄していただいて差し支えありません。',
  ].join('\n');

  return { to: params.to, subject, text };
}
