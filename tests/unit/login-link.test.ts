import { describe, expect, it } from 'vitest';

import {
  hasLoginLinkFragment,
  LOGIN_LINK_PATH,
  loginLinkUrl,
  readLoginLinkFragment,
} from '@/lib/auth/login-link';

describe('loginLinkUrl（ワンタイム認証メールの戻り先）', () => {
  it('next が無ければ着地画面だけ', () => {
    expect(loginLinkUrl('https://app.example.test', null)).toBe(
      `https://app.example.test${LOGIN_LINK_PATH}`,
    );
  });

  it('next をエンコードしてクエリに載せる', () => {
    expect(loginLinkUrl('https://app.example.test', '/mypage/tasks?tab=needs_fix')).toBe(
      'https://app.example.test/login/link?next=%2Fmypage%2Ftasks%3Ftab%3Dneeds_fix',
    );
  });
});

describe('readLoginLinkFragment（着地画面でのフラグメントの読み取り）', () => {
  // Supabase のテンプレートが出力する形（Step 0 の実測、#104）。& はブラウザが &amp; から戻した後の値
  it('Supabase が URL エスケープしたアドレスを元に戻す', () => {
    expect(readLoginLinkFragment('#e=demo-02-groom%40demo.nicomaru.test&c=373611')).toEqual({
      email: 'demo-02-groom@demo.nicomaru.test',
      code: '373611',
    });
  });

  it("'+' を含むアドレス（%2b）を空白に化けさせない", () => {
    expect(readLoginLinkFragment('#e=step0%2btag%40e2e.test&c=360231')).toEqual({
      email: 'step0+tag@e2e.test',
      code: '360231',
    });
  });

  it('先頭の # が無くても読める・大文字は小文字にそろえる', () => {
    expect(readLoginLinkFragment('e=Groom%40Example.Test&c=000123')).toEqual({
      email: 'groom@example.test',
      code: '000123',
    });
  });

  it.each([
    ['5桁', '12345'],
    ['7桁', '1234567'],
    ['数字以外', '12a456'],
    ['空', ''],
  ])('コードが6桁の数字でなければ code は null（%s）', (_label, code) => {
    expect(readLoginLinkFragment(`#e=a%40example.test&c=${code}`)).toEqual({
      email: 'a@example.test',
      code: null,
    });
  });

  it.each([
    ['@ なし', 'example.test'],
    ['空白入り', 'a%20b%40example.test'],
    ['空', ''],
    ['長すぎる', `${'a'.repeat(250)}%40example.test`],
  ])('アドレスの形が合わなければ email は null（%s）', (_label, email) => {
    expect(readLoginLinkFragment(`#e=${email}&c=123456`)).toEqual({
      email: null,
      code: '123456',
    });
  });

  it('フラグメントが無ければ両方 null', () => {
    expect(readLoginLinkFragment('')).toEqual({ email: null, code: null });
  });
});

describe('hasLoginLinkFragment（ログイン画面に着いたときの転送判定）', () => {
  it.each(['#e=a%40example.test&c=123456', '#c=123456', '#e='])('%s は転送する', (hash) => {
    expect(hasLoginLinkFragment(hash)).toBe(true);
  });

  it.each(['', '#', '#access_token=x&refresh_token=y', '#error_description=expired'])(
    '%s は転送しない（旧形式のリンクの着地処理に任せる）',
    (hash) => {
      expect(hasLoginLinkFragment(hash)).toBe(false);
    },
  );
});
