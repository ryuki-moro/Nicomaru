/**
 * メールのログインリンク（/login/link#e=<メールアドレス>&c=<6桁コード>）の組み立てと読み取り。
 *
 * 正本: 基本設計書 Version 1.2 6-3-1「認証方式」方針(1)。
 *
 * リンクはメールアドレスと6桁コードを URL フラグメントで渡し、着地画面（/login/link）で
 * 利用者がボタンを押したときだけ、コード入力と同じ /api/auth/otp-verify で検証する。
 *   - フラグメントはサーバーへ送られないので、メールのセキュリティスキャナが GET しても何も消費しない
 *     （従来の {{ .ConfirmationURL }} は GET でコードごと失効した）
 *   - PKCE のように要求元ブラウザへ縛られないので、メールアプリ内ブラウザなど別のブラウザでも成立する
 *     （同じメールのコードは元々どのブラウザでも使えるため、安全性は下がらない）
 * フラグメントの形は supabase/templates/magic_link.html の href と対で決まる。
 */
import { OTP } from '@/lib/constants';

/** 着地画面のパス。/login 配下なので middleware の公開パスに含まれる */
export const LOGIN_LINK_PATH = '/login/link';

const CODE_PATTERN = new RegExp(`^\\d{${OTP.length}}$`);
/** 形の粗い確認だけ。正しいアドレスかどうかは otp-verify の検証が決める */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const EMAIL_MAX_LENGTH = 255;

/**
 * ワンタイム認証メールの戻り先（emailRedirectTo）。next は normalizeNext 済みの値を渡す。
 * Supabase はこの値をテンプレートの {{ .RedirectTo }} に入れる。
 */
export function loginLinkUrl(appBaseUrl: string, next: string | null): string {
  const base = `${appBaseUrl}${LOGIN_LINK_PATH}`;
  return next ? `${base}?next=${encodeURIComponent(next)}` : base;
}

/** フラグメントから読み取った値。形が合わない項目は null */
export interface LoginLinkFragment {
  email: string | null;
  code: string | null;
}

/**
 * URL フラグメント（'#e=…&c=…'）からメールアドレスと6桁コードを読む。
 *
 * Supabase はテンプレートの {{ .Email }} を URL エスケープして出力する（'@' → '%40'、'+' → '%2b'）。
 * URLSearchParams はこれを元のアドレスへ戻す（'%2b' は空白に化けない）。
 */
export function readLoginLinkFragment(hash: string): LoginLinkFragment {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const email = params.get('e')?.trim().toLowerCase() ?? '';
  const code = params.get('c')?.trim() ?? '';
  return {
    email: email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email) ? email : null,
    code: CODE_PATTERN.test(code) ? code : null,
  };
}

/** ログインリンクのフラグメントを含むか（ログイン画面に着いてしまった場合の転送判定） */
export function hasLoginLinkFragment(hash: string): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return params.has('e') || params.has('c');
}
