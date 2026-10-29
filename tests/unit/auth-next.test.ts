import { describe, expect, it } from 'vitest';

import { buildNext, normalizeNext, safeNext } from '@/lib/auth/next';

describe('safeNext（遷移先の形の検証）', () => {
  it.each([
    '/mypage',
    '/mypage/tasks/7f6c2b1e-0000-4000-8000-000000000001',
    '/mypage/tasks?tab=needs_fix',
    '/venues/%2F%2Fevil.example.test',
  ])('自サイト内の絶対パス %s を通す', (next) => {
    expect(safeNext(next)).toBe(next);
  });

  it.each([
    ['protocol-relative', '//evil.example.test'],
    ['バックスラッシュ', '/\\evil.example.test'],
    ['途中のバックスラッシュ', '/mypage\\..\\x'],
    ['絶対URL', 'https://evil.example.test/mypage'],
    ['javascript スキーム', 'javascript:alert(1)'],
    ['相対パス', 'mypage'],
    ['改行', '/mypage\nSet-Cookie: x=1'],
    ['タブ', '/mypage\t'],
    ['NUL', '/mypage\u0000'],
    ['DEL', '/mypage\u007F'],
    ['空文字', ''],
  ])('%s は拒否する', (_label, next) => {
    expect(safeNext(next)).toBeNull();
  });

  it('未指定は null', () => {
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext(null)).toBeNull();
  });
});

describe('buildNext（middleware が作る戻り先）', () => {
  const build = (pathname: string, query = '') => buildNext(pathname, new URLSearchParams(query));

  it('パスだけならそのまま', () => {
    expect(build('/mypage/tasks')).toBe('/mypage/tasks');
  });

  it('許可キー tab・page を残し、決まった順に並べる', () => {
    expect(build('/mypage/tasks', 'page=2&tab=needs_fix')).toBe(
      '/mypage/tasks?tab=needs_fix&page=2',
    );
  });

  it.each(['token', 'linkToken', 'next', 'code', 'access_token', 'email', 'TAB'])(
    '許可していないキー %s は捨てる',
    (key) => {
      expect(build('/mypage/account', `${key}=private-value&tab=line`)).toBe(
        '/mypage/account?tab=line',
      );
    },
  );

  it.each([
    ['空', ''],
    ['33文字', 'a'.repeat(33)],
    ['記号', 'needs fix'],
    ['URL', 'https://evil.example.test'],
    ['パス', '/x'],
    ['日本語', '不備あり'],
  ])('許可キーでも値が規則外（%s）なら捨てる', (_label, value) => {
    const query = new URLSearchParams({ tab: value }).toString();
    expect(build('/mypage/tasks', query)).toBe('/mypage/tasks');
  });

  it('同じキーが複数あるときは先頭の値だけを使う', () => {
    expect(build('/mypage/tasks', 'tab=needs_fix&tab=done')).toBe('/mypage/tasks?tab=needs_fix');
  });

  it('ルートは戻り先にしない（クエリがあっても）', () => {
    expect(build('/')).toBeNull();
    expect(build('/', 'tab=needs_fix')).toBeNull();
  });

  it('パスが安全でなければ戻り先にしない', () => {
    expect(build('//evil.example.test', 'tab=x')).toBeNull();
  });
});

describe('normalizeNext（外から受け取った ?next= の正規化）', () => {
  it('許可キー以外のクエリとフラグメントを落とす', () => {
    expect(normalizeNext('/mypage/account?linkToken=private&tab=line#frag')).toBe(
      '/mypage/account?tab=line',
    );
    expect(normalizeNext('/mypage/tasks?token=private')).toBe('/mypage/tasks');
  });

  it('許可キーだけの戻り先は変わらない', () => {
    expect(normalizeNext('/mypage/tasks?tab=needs_fix&page=3')).toBe(
      '/mypage/tasks?tab=needs_fix&page=3',
    );
    expect(normalizeNext('/venues/%2F%2Fevil.example.test')).toBe(
      '/venues/%2F%2Fevil.example.test',
    );
  });

  it.each(['//evil.example.test', '/\\evil.example.test', 'https://evil.example.test', ''])(
    '形が不正な %s は null',
    (next) => {
      expect(normalizeNext(next)).toBeNull();
    },
  );

  it('解析後に protocol-relative になる形も null', () => {
    // '/./' は safeNext を通るが、URL として解釈すると '//evil.example.test' になる
    expect(normalizeNext('/.//evil.example.test')).toBeNull();
  });

  it('ルートは null（役割別の初期画面へ戻す）', () => {
    expect(normalizeNext('/')).toBeNull();
    expect(normalizeNext('/?tab=x')).toBeNull();
  });

  it('未指定は null', () => {
    expect(normalizeNext(undefined)).toBeNull();
  });
});
