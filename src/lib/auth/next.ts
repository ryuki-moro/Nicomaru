/**
 * ログイン後の戻り先（?next=）の組み立てと検証。
 *
 * 正本: 基本設計書 Version 1.2 4-2「画面遷移の概要」／6-5（ログイン後に元の画面へ復帰）／12-1。
 *
 * middleware（未ログインで保護画面を開いたとき）・ログイン画面・ワンタイム認証メールの
 * 戻り先（/api/auth/otp-request の emailRedirectTo）で同じ規則を使うため、ここに集約する。
 * 戻り先の扱いを画面ごとに書くと、片方だけ緩い判定が残る。
 *
 * 【クエリは許可キーだけ】
 * 戻り先はログインURL・Supabase に預けるメールの戻り先・メール本文のリンクへ載る。
 * `/mypage/account?linkToken=…` のような機微値をそこへ持ち出さないよう、
 * 一覧の絞り込みに要る最小限のキー（NEXT_QUERY_KEYS）だけを残し、それ以外は捨てる。
 */

/**
 * 遷移先として許可する ?next= の形。
 *
 *   ^\/                       自サイト内の絶対パスに限る（'https://…' や 'javascript:' を弾く）
 *   (?![/\\])                 2文字目が '/' でも '\' でもないこと
 *   [^\u0000-\u001F\u007F\\]* 以降にバックスラッシュと制御文字を含まないこと
 *
 * '//' だけを見る判定では '/\evil.com' が素通りする。ブラウザは URL のパス区切りで
 * '\' を '/' と同一視するため、これを protocol-relative URL（'//evil.com'）として解釈し、
 * 外部サイトへ遷移してしまう。P01 の couple はパスワードを持たず、メールと6桁コードだけで
 * ログインする（6-3-1）ので、偽のログイン画面へ誘導されること自体がアカウント奪取に直結する。
 * 制御文字（改行・タブ・NUL）も、遷移先の見た目を偽装したりヘッダを分割したりする材料に
 * なるため同時に弾く。条件を複数の startsWith に分けると取りこぼしが生まれるので、1本にまとめる。
 */
const SAFE_NEXT_PATTERN = /^\/(?![/\\])[^\u0000-\u001F\u007F\\]*$/;

/** next に残してよいクエリのキー。一覧のタブとページ番号だけ */
export const NEXT_QUERY_KEYS = ['tab', 'page'] as const;

/** 許可キーの値。英数字・'_'・'-' の32文字まで（トークン類を紛れ込ませる余地を残さない） */
const NEXT_QUERY_VALUE = /^[A-Za-z0-9_-]{1,32}$/;

/** URL 解析だけに使う仮の基点。結果には現れない */
const PARSE_BASE = 'http://next.invalid';

/** オープンリダイレクト防止。自サイト内の絶対パスだけを許可する（12-1）。 */
export function safeNext(next: string | null | undefined): string | null {
  if (!next) return null;
  return SAFE_NEXT_PATTERN.test(next) ? next : null;
}

/**
 * パスとクエリから戻り先を組み立てる（middleware 用）。
 *
 * クエリは NEXT_QUERY_KEYS のうち値が規則に合うものだけを、この順で残す。
 * ルート（'/'）は戻り先にしない。ログイン後は役割別の初期画面へ行けば足りる（4-2）。
 */
export function buildNext(pathname: string, searchParams: URLSearchParams): string | null {
  if (pathname === '/') return null;

  const kept = new URLSearchParams();
  for (const key of NEXT_QUERY_KEYS) {
    const value = searchParams.get(key);
    if (value !== null && NEXT_QUERY_VALUE.test(value)) kept.set(key, value);
  }
  const query = kept.toString();
  return safeNext(query ? `${pathname}?${query}` : pathname);
}

/**
 * 外から受け取った ?next= の値を、buildNext と同じ形にそろえる（ログイン画面・otp-request 用）。
 *
 * ?next= は利用者が書き換えられるので、形の検証（safeNext）に加えて
 * クエリを許可キーだけに絞り直す。不正なら null（呼び出し側は戻り先なしとして扱う）。
 */
export function normalizeNext(next: string | null | undefined): string | null {
  const checked = safeNext(next);
  if (!checked) return null;

  const url = new URL(checked, PARSE_BASE);
  // 解析で別オリジンに解釈される形は、safeNext を通っていても採らない
  if (url.origin !== PARSE_BASE) return null;
  return buildNext(url.pathname, url.searchParams);
}
