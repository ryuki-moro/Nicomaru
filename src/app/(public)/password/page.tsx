import type { Metadata } from 'next';

import { PasswordForms } from './PasswordForms';

export const metadata: Metadata = { title: 'パスワードの設定' };

/**
 * P03 パスワード再設定画面（planner／admin／system_admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 P03／6-3-1「認証方式」。
 *   ステップ1: メールアドレス入力 → 再設定リンク送信
 *   ステップ2: 新パスワード・確認（12文字以上・一致・漏えいパスワード拒否）→ 更新後 P01 へ
 *   本画面は初回パスワード設定の着地画面を兼ね、初回設定時は見出し・案内文のみを差し替える。
 *
 * couple はパスワードを設定しないため対象外（13-1）。
 *
 * mode の由来:
 *   'reset'  = /api/auth/password-reset が指定する redirectTo
 *   'invite' = U02／S02 が Auth Admin API の generateLink(type=invite) で指定する着地先
 * どちらの経路でも、実際にどのステップを表示するかは
 * リンク由来のセッションを確立できたかどうかで決まるため、判定は PasswordForms 側で行う。
 */
export default async function PasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  return <PasswordForms mode={mode === 'invite' ? 'invite' : 'reset'} />;
}
