import { describe, expect, it } from 'vitest';

import { assertDemoAppTarget, assertDemoProjectTargets } from '../../scripts/demo/targets';

const REF = 'abcdefghijklmnopqrst';
const API = `https://${REF}.supabase.co`;

describe('デモ投入前の接続先照合', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('標準ローカルを許す: %s', (host) => {
    expect(() =>
      assertDemoProjectTargets(
        `http://${host}:54321`,
        'postgres://postgres:fixture@127.0.0.1:54322/postgres',
      ),
    ).not.toThrow();
  });
  it.each([
    `postgres://postgres:fixture@db.${REF}.supabase.co:5432/postgres`,
    `postgresql://postgres.${REF}:fixture@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require`,
  ])('公式の同一project-refを許す: %s', (dbUrl) => {
    expect(() => assertDemoProjectTargets(API, dbUrl)).not.toThrow();
  });
  it.each([
    `postgres://postgres:fixture@db.zyxwvutsrqponmlkjihg.supabase.co:5432/postgres`,
    `postgres://postgres.zyxwvutsrqponmlkjihg:fixture@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`,
    `postgres://postgres.${REF}:fixture@unverified.example.test:5432/postgres`,
    `postgres://postgres:fixture@db.${REF}.supabase.co:5432/postgres?host=db.other.supabase.co`,
    `postgres://postgres:fixture@db.${REF}.supabase.co:5432/another_database`,
    'postgres://postgres:fixture@127.0.0.1:54322/postgres',
  ])('不一致・迂回・未確認のDB接続先を拒否: %s', (dbUrl) => {
    expect(() => assertDemoProjectTargets(API, dbUrl)).toThrow();
  });
  it.each([
    ['http://localhost:54321', 'postgres://postgres:fixture@localhost:55322/postgres'],
    ['http://localhost:55321', 'postgres://postgres:fixture@localhost:54322/postgres'],
    [
      'https://custom.example.test',
      `postgres://postgres:fixture@db.${REF}.supabase.co:5432/postgres`,
    ],
    [
      `https://${REF}.supabase.co?host=private`,
      `postgres://postgres:fixture@db.${REF}.supabase.co:5432/postgres`,
    ],
  ])('標準外の組を推測しない: %s', (apiUrl, dbUrl) => {
    expect(() => assertDemoProjectTargets(apiUrl, dbUrl)).toThrow();
  });
  it('不正URLの資格情報をエラーへ含めない', () => {
    try {
      assertDemoProjectTargets('invalid url with private-value', 'password-secret');
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as Error).message).not.toMatch(/private-value|password-secret/);
    }
  });
});

describe('デモ投入後のアプリ接続先', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('ローカルのアプリを許す: %s', (host) => {
    expect(() => assertDemoAppTarget(`http://${host}:3000`, false)).not.toThrow();
  });
  it('ローカル実行から外部アプリへの接続を拒否する', () => {
    expect(() => assertDemoAppTarget('https://other.example.test', false)).toThrow('loopback');
  });
  it('明示したremote実行では公開アプリを許す', () => {
    expect(() => assertDemoAppTarget('https://demo.example.test', true)).not.toThrow();
  });
  it.each([
    'file:///private/path',
    'http://user:secret@localhost:3000',
    'http://localhost:3000/other-path',
    'http://localhost:3000?secret=value',
    'http://localhost:3000#token',
    'invalid URL',
  ])('不正なアプリOriginを拒否する: %s', (appUrl) => {
    expect(() => assertDemoAppTarget(appUrl, false)).toThrow();
  });
});
