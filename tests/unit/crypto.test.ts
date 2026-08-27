/**
 * 13-1「個人情報の暗号化」の決定（アプリ側 AES-256-GCM ＋ 検索用 HMAC-SHA256）を検証する。
 * 12-2 の「人手レビュー必須領域」に含まれるため、退行をテストで固定する。
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { decryptPii, emailHash, encryptPii, hmacHash, normalizeEmail, safeEqual } from '@/lib/crypto';

beforeAll(() => {
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.PII_HMAC_KEY = randomBytes(32).toString('base64');
});

describe('encryptPii / decryptPii', () => {
  it('往復して元の値に戻る', () => {
    const value = '山田 太郎';
    expect(decryptPii(encryptPii(value))).toBe(value);
  });

  it('日本語・絵文字・長文でも壊れない', () => {
    const value = `${'あ'.repeat(1000)}🎉<script>alert(1)</script>`;
    expect(decryptPii(encryptPii(value))).toBe(value);
  });

  it('同じ平文でも毎回異なる暗号文になる（IV がランダム）', () => {
    const a = encryptPii('same');
    const b = encryptPii('same');
    expect(a).not.toBe(b);
    expect(decryptPii(a)).toBe('same');
    expect(decryptPii(b)).toBe('same');
  });

  it('null / undefined / 空文字は null を返す（NULL可の列をそのまま扱える）', () => {
    expect(encryptPii(null)).toBeNull();
    expect(encryptPii(undefined)).toBeNull();
    expect(encryptPii('')).toBeNull();
    expect(decryptPii(null)).toBeNull();
    expect(decryptPii('')).toBeNull();
  });

  it('改ざんされた暗号文は復号に失敗する（GCM の認証タグ）', () => {
    const encrypted = encryptPii('secret') as string;
    const parts = encrypted.split(':');
    const body = Buffer.from(parts[2], 'base64url');
    body[0] ^= 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${body.toString('base64url')}`;
    expect(() => decryptPii(tampered)).toThrow();
  });

  it('形式が違う値は例外にする（平文の取り違えを検出する）', () => {
    expect(() => decryptPii('平文がそのまま入っている')).toThrow();
    expect(() => decryptPii('v9:aaa:bbb')).toThrow();
  });

  it('鍵長が32バイトでなければ起動時に落とす', () => {
    const saved = process.env.PII_ENCRYPTION_KEY;
    process.env.PII_ENCRYPTION_KEY = randomBytes(16).toString('base64');
    expect(() => encryptPii('x')).toThrow(/32 バイト/);
    process.env.PII_ENCRYPTION_KEY = saved;
  });
});

describe('normalizeEmail / emailHash', () => {
  it('前後の空白と大文字小文字を吸収する', () => {
    expect(normalizeEmail('  Groom@Example.TEST ')).toBe('groom@example.test');
  });

  it('表記ゆれがあっても同じハッシュになる（招待メールの照合。6-6-1）', () => {
    expect(emailHash(' Groom@Example.TEST ')).toBe(emailHash('groom@example.test'));
  });

  it('別のメールアドレスは別のハッシュになる', () => {
    expect(emailHash('a@example.test')).not.toBe(emailHash('b@example.test'));
  });

  it('ハッシュは決定的で、平文を含まない', () => {
    const hash = emailHash('groom@example.test');
    expect(hash).toBe(emailHash('groom@example.test'));
    expect(hash).not.toContain('groom');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('HMAC は鍵に依存する（鍵が漏れない限り総当たりで逆引きされない）', () => {
    const before = hmacHash('value');
    process.env.PII_HMAC_KEY = randomBytes(32).toString('base64');
    expect(hmacHash('value')).not.toBe(before);
  });
});

describe('safeEqual', () => {
  it('同じ文字列で true', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('異なる文字列・異なる長さで false', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
