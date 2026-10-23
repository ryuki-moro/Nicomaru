import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// #103の有効期限検証はそのブランチで管理し、ここではリンクの契約だけを検証する。
describe('メールのログインリンク', () => {
  it('メールアドレスとコードをフラグメントで渡し、GETで消費するURLを使わない', () => {
    const template = readFileSync('supabase/templates/magic_link.html', 'utf8');
    expect(template).toContain('href="{{ .RedirectTo }}#e={{ .Email }}&amp;c={{ .Token }}"');
    expect(template).not.toContain('ConfirmationURL');
  });
});
