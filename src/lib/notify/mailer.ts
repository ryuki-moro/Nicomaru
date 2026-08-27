/**
 * メール送信（Resend）と、初回パスワード設定リンクの発行・送信。
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
 * 【RESEND_API_KEY が無い環境】
 * 13-1 の決定により、Phase 1 の開発段階は「開発者宛送信で検証できる段階」を設ける。
 * キー未設定のときは送信せず、宛先・件名・本文をサーバーログへ出して処理を続行する。
 * 送信できなかった事実は MailResult で呼び出し元へ返し、画面に注意文として表示させる。
 * 設定リンクを含む本文をログへ出すのはキー未設定のローカル開発時に限られる（本番では
 * キーが必ず設定されるため到達しない）。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { INVITE_LINK_TTL_HOURS, PASSWORD_MIN_LENGTH } from '@/lib/constants';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export type MailResult =
  | { delivered: true; providerMessageId: string | null }
  | { delivered: false; reason: 'not_configured' | 'provider_error'; detail?: string };

/** 招待URL・通知URLの生成に使う（表12-2 APP_BASE_URL）。 */
export function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? 'http://localhost:3000';
}

export async function sendMail(message: MailMessage): Promise<MailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;

  if (!apiKey || !from) {
    console.info(
      '[mail] RESEND_API_KEY／RESEND_FROM が未設定のため送信をスキップしました（13-1 開発者宛検証段階）\n'
      + `  to: ${message.to}\n  subject: ${message.subject}\n${message.text}`,
    );
    return { delivered: false, reason: 'not_configured' };
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
    });

    if (!response.ok) {
      // 本文には宛先が含まれるため、詳細はサーバーログにのみ残す（9章）
      console.error('[mail] 送信に失敗しました', response.status, await response.text());
      return { delivered: false, reason: 'provider_error', detail: `HTTP ${response.status}` };
    }

    const body = (await response.json()) as { id?: string };
    return { delivered: true, providerMessageId: body.id ?? null };
  } catch (error) {
    console.error('[mail] 送信要求が例外で終了しました', error);
    return { delivered: false, reason: 'provider_error' };
  }
}

// ------------------------------------------ 初回パスワード設定リンク（6-3-1／U02・U03）

export type IssueLinkResult =
  | { ok: true; authUserId: string; actionLink: string }
  | { ok: false; reason: 'already_registered' | 'provider_error'; detail?: string };

/**
 * Auth Admin API の generateLink で初回パスワード設定リンクを発行する（6-3-1）。
 *
 * - 新規登録（U02）は type='invite'。Auth ユーザーが同時に作成され、その id を返す。
 * - 再送（U03）は既に Auth ユーザーが存在し invite が拒否されうるため type='recovery' を先に試す。
 *   どちらも着地画面は P03 のステップ2 で、有効期限は Supabase 側の設定（72時間）に従う。
 *
 * @param admin createSupabaseAdminClient('admin.users') で作ったクライアント（6-3-5 表6-4）
 */
export async function issuePasswordSetupLink(
  admin: SupabaseClient,
  params: { email: string; isResend?: boolean },
): Promise<IssueLinkResult> {
  // P03 のステップ2 が「初回設定」の見出し・案内文へ切り替えるための目印（6-3-1）
  const redirectTo = `${appBaseUrl()}/password?mode=invite`;
  const order: ('invite' | 'recovery')[] = params.isResend
    ? ['recovery', 'invite']
    : ['invite', 'recovery'];

  let lastDetail: string | undefined;

  for (const type of order) {
    // GenerateLinkParams は type ごとの直和型なので、変数のままでは代入できない
    const { data, error } = type === 'invite'
      ? await admin.auth.admin.generateLink({ type: 'invite', email: params.email, options: { redirectTo } })
      : await admin.auth.admin.generateLink({ type: 'recovery', email: params.email, options: { redirectTo } });

    if (!error && data?.user && data.properties) {
      return { ok: true, authUserId: data.user.id, actionLink: data.properties.action_link };
    }

    lastDetail = error?.message;
    // invite は「既に登録済み」で失敗する。新規登録の入口ではそのまま 409 にしたい
    if (type === 'invite' && !params.isResend && /already|registered|exists/i.test(lastDetail ?? '')) {
      return { ok: false, reason: 'already_registered', detail: lastDetail };
    }
  }

  console.error('[mail] 初回パスワード設定リンクを発行できませんでした', lastDetail);
  return { ok: false, reason: 'provider_error', detail: lastDetail };
}

/** 初回パスワード設定リンクの本文（U02／U03）。圧迫感を与えない案内文にする（要件 8）。 */
export function sendPasswordSetupMail(params: {
  to: string;
  displayName: string;
  roleLabel: string;
  venueName?: string | null;
  actionLink: string;
  isResend?: boolean;
}): Promise<MailResult> {
  const belongs = params.venueName ? `${params.venueName}の` : '';
  const subject = params.isResend
    ? '【にこまる】パスワード設定リンクの再送のご案内'
    : '【にこまる】アカウント登録のご案内';

  const text = [
    `${params.displayName} 様`,
    '',
    `${belongs}にこまる（BridalHub）に、${params.roleLabel}としてのアカウントをご用意しました。`,
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

  return sendMail({ to: params.to, subject, text });
}
