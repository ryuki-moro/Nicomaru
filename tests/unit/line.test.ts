/**
 * LINE 連携の署名検証と nonce（6-10）。
 *
 * 第11章「認証／認可テスト」に対応する。署名検証は Webhook の唯一の認証手段なので、
 * 「通ってはいけないものが通らない」ことをここで固める。
 */
import { createHmac } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  accountLinkUrl,
  generateLinkNonce,
  hashLinkNonce,
  verifyLineSignature,
} from '@/lib/notify/line';

const SECRET = 'test-channel-secret';
const sign = (body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(body, 'utf8').digest('base64');

beforeAll(() => {
  process.env.LINE_CHANNEL_SECRET = SECRET;
});

describe('verifyLineSignature（6-10）', () => {
  const body = JSON.stringify({ destination: 'U123', events: [{ type: 'follow' }] });

  it('正しい署名を受け入れる', () => {
    expect(verifyLineSignature(body, sign(body))).toBe(true);
  });

  it('署名が無ければ拒否する', () => {
    expect(verifyLineSignature(body, null)).toBe(false);
    expect(verifyLineSignature(body, '')).toBe(false);
  });

  it('別のシークレットで作られた署名を拒否する', () => {
    expect(verifyLineSignature(body, sign(body, 'other-secret'))).toBe(false);
  });

  it('本文が1文字でも変われば拒否する（改ざん検出）', () => {
    const signature = sign(body);
    expect(verifyLineSignature(`${body} `, signature)).toBe(false);
    expect(verifyLineSignature(body.replace('follow', 'unfollw'), signature)).toBe(false);
  });

  it('キーの順序が変わった同等のJSONは拒否する（raw body に対して検証している証拠）', () => {
    // 6-10 が「raw body に対して行う」と定める理由。
    // パース後の値から再構築すると、この2つが同じ署名になってしまう。
    const reordered = JSON.stringify({ events: [{ type: 'follow' }], destination: 'U123' });
    expect(reordered).not.toBe(body);
    expect(verifyLineSignature(reordered, sign(body))).toBe(false);
  });

  it('長さの違う署名でも例外にならず false を返す（定数時間比較の前提）', () => {
    expect(verifyLineSignature(body, 'short')).toBe(false);
    expect(verifyLineSignature(body, 'x'.repeat(200))).toBe(false);
  });

  it('チャネルシークレットが未設定なら常に拒否する', () => {
    const saved = process.env.LINE_CHANNEL_SECRET;
    delete process.env.LINE_CHANNEL_SECRET;
    expect(verifyLineSignature(body, sign(body))).toBe(false);
    process.env.LINE_CHANNEL_SECRET = saved;
  });
});

describe('連携 nonce', () => {
  it('毎回異なる推測困難な値を作る', () => {
    const nonces = new Set(Array.from({ length: 200 }, () => generateLinkNonce()));
    expect(nonces.size).toBe(200);
  });

  it('URL に安全な文字だけを含む', () => {
    expect(generateLinkNonce()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('ハッシュは決定的で、平文を含まない（DBには平文を保存しない）', () => {
    const nonce = generateLinkNonce();
    const hash = hashLinkNonce(nonce);
    expect(hash).toBe(hashLinkNonce(nonce));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(nonce);
  });
});

describe('accountLinkUrl', () => {
  it('LINE のアカウント連携ダイアログへ linkToken と nonce を渡す', () => {
    const url = new URL(accountLinkUrl('token-abc', 'nonce-xyz'));
    expect(url.origin + url.pathname).toBe('https://access.line.me/dialog/bot/accountLink');
    expect(url.searchParams.get('linkToken')).toBe('token-abc');
    expect(url.searchParams.get('nonce')).toBe('nonce-xyz');
  });

  it('特殊文字を含む値をエスケープする', () => {
    const url = new URL(accountLinkUrl('a b&c', 'd/e'));
    expect(url.searchParams.get('linkToken')).toBe('a b&c');
    expect(url.searchParams.get('nonce')).toBe('d/e');
  });
});
