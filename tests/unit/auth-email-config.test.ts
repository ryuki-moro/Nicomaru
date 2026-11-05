import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { OTP } from '@/lib/constants';

/**
 * ワンタイムコードの有効期限・桁数を、画面（OTP）・Supabase Auth の設定（config.toml）・
 * メール本文（magic_link.html）の3か所でそろえる（基本設計書 5-3: 10分・6桁）。
 * 設定と文面は TypeScript から参照されないため、食い違っても型検査や他のテストでは気付けない。
 */
const configToml = readFileSync('supabase/config.toml', 'utf8');

/** `[section]` の直下（次の見出しまで）にある `key = value` を読む。値は前後の引用符を外す */
function tomlValue(section: string, key: string): string | undefined {
  const lines = configToml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
    if (match) return match[1].replace(/^"(.*)"$/, '$1');
  }
  return undefined;
}

function magicLinkTemplate(): string {
  const contentPath = tomlValue('auth.email.template.magic_link', 'content_path');
  expect(contentPath).toBeDefined();
  return readFileSync(contentPath!, 'utf8');
}

describe('ワンタイムコードの設定と文面', () => {
  it('Supabase Auth の otp_expiry が画面の有効期限（OTP.ttlSeconds）と一致する', () => {
    expect(Number(tomlValue('auth.email', 'otp_expiry'))).toBe(OTP.ttlSeconds);
  });

  it('Supabase Auth の otp_length が画面の桁数（OTP.length）と一致する', () => {
    expect(Number(tomlValue('auth.email', 'otp_length'))).toBe(OTP.length);
  });

  it('メール本文の有効期限が分単位で OTP.ttlSeconds と一致する', () => {
    const template = magicLinkTemplate();
    const stated = [...template.matchAll(/有効期限は(\d+)(分|時間)/g)];

    expect(stated).toHaveLength(1);
    const [, amount, unit] = stated[0];
    expect(unit).toBe('分');
    expect(Number(amount)).toBe(OTP.ttlSeconds / 60);
  });

  it('メール本文にワンタイムコード（{{ .Token }}）と桁数の案内がある', () => {
    const template = magicLinkTemplate();

    expect(template).toContain('{{ .Token }}');
    expect(template).toContain(`${OTP.length}桁`);
  });
});

describe('メールのログインリンク', () => {
  it('メールアドレスとコードをフラグメントで渡し、GETで消費するURLを使わない', () => {
    const template = magicLinkTemplate();
    expect(template).toContain('href="{{ .RedirectTo }}#e={{ .Email }}&amp;c={{ .Token }}"');
    expect(template).not.toContain('ConfirmationURL');
  });
});
