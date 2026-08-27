/**
 * 個人情報のアプリケーション側暗号化と検索用ハッシュ。
 *
 * 正本: 基本設計書 Version 1.2 13-1「開発チーム決定」
 *   - アプリケーション側暗号化（AES-256-GCM）＋検索用 HMAC-SHA256 ハッシュ列
 *   - 対象は 5-3 で「暗号化対象」と付記した列
 *   - 等値一致検索は併設した HMAC 列で行う（部分一致は非対応）
 *
 * 鍵はサーバー側の環境変数にのみ置き、ブラウザへ露出させない（12-1）。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'v1';

function requireKey(name: string, bytes: number): Buffer {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(`${name} が設定されていません（.env.example を参照）`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== bytes) {
    throw new Error(`${name} は base64 で ${bytes} バイトである必要があります（現在 ${key.length}）`);
  }
  return key;
}

/** 暗号化・HMAC の鍵。テストから差し替えられるよう遅延解決する。 */
export const keys = {
  encryption: () => requireKey('PII_ENCRYPTION_KEY', 32),
  hmac: () => requireKey('PII_HMAC_KEY', 32),
};

/**
 * 暗号化対象カラムの値を暗号化する。
 * 形式: v1:<iv(base64url)>:<ciphertext+tag(base64url)>
 */
export function encryptPii(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keys.encryption(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${PREFIX}:${iv.toString('base64url')}:${body.toString('base64url')}`;
}

/** 暗号化された値を復号する。改ざんされている場合は例外を投げる。 */
export function decryptPii(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === '') return null;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    throw new Error('暗号化データの形式が不正です');
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const body = Buffer.from(parts[2], 'base64url');
  if (body.length <= TAG_BYTES) {
    throw new Error('暗号化データの形式が不正です');
  }
  const tag = body.subarray(body.length - TAG_BYTES);
  const ciphertext = body.subarray(0, body.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, keys.encryption(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * 表示用の復号。復号できない値はそのまま返す。
 *
 * 暗号化列には、鍵のローテーション前に書かれた値・移行途中の平文・
 * 別環境の鍵で暗号化された値が混ざりうる。そこで例外を投げると、
 * 一覧画面（K01）や招待URLの発行応答まで 500 になり、影響が表示以外へ波及する。
 * 復号できない値を「読めないまま出す」ほうが被害が小さいので、ここで畳む。
 *
 * 一方、提出内容の編集フォームのように「読めない値をそのまま再送信されると困る」場面では、
 * 呼び出し側が isEncrypted() で判定して空欄にする。
 */
export function readPii(stored: string | null | undefined): string {
  if (stored === null || stored === undefined || stored === '') return '';
  try {
    return decryptPii(stored) ?? '';
  } catch {
    return stored;
  }
}

/** 値が暗号化形式かどうか。復号できない値を編集フォームへ流さないための判定に使う。 */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

/**
 * メールアドレスの正規化。
 * 招待トークンと登録メールの照合（6-6-1）で、表記ゆれによる不一致を避けるために用いる。
 * ローカル部の大文字小文字はRFC上は区別されうるが、実運用では区別しない扱いに統一する。
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 等値一致検索・照合に用いる HMAC-SHA256（5-1）。 */
export function hmacHash(value: string): string {
  return createHmac('sha256', keys.hmac()).update(value, 'utf8').digest('hex');
}

/** 正規化したメールアドレスの HMAC。couple_profiles.email_hash などに格納する。 */
export function emailHash(email: string): string {
  return hmacHash(normalizeEmail(email));
}

/** タイミング攻撃に強い比較。トークン・ハッシュの照合に用いる。 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
