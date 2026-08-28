/**
 * 機能9-4 のルールベース検査（7-2 の①）。
 *
 * 7-2 は「①ルールベースは決定的に判定できるためコードで実装する」「②の精度が不足した場合は
 * ①のみで運用する（縮退案）」と定める。つまり①は LLM が使えない状況でも動く必要がある。
 * その前提を守るため、①の挙動をここで固定する。
 */
import { describe, expect, it } from 'vitest';

import { checkCsvDefects, parseCsv, type CsvSchemaDefinition } from '@/lib/ai/defectCheck';

const schema: CsvSchemaDefinition = {
  columns: [
    { name: '氏名', required: true },
    { name: 'ふりがな', required: false },
    { name: '郵便番号', required: true, pattern: '^\\d{3}-?\\d{4}$', patternHint: '郵便番号は7桁でご記入ください' },
    { name: '住所', required: true },
  ],
  uniqueBy: ['氏名'],
  maxRows: 5,
};

const header = '氏名,ふりがな,郵便番号,住所';

describe('parseCsv', () => {
  it('BOM を取り除く（Excel が付けるとヘッダー名が一致しなくなる）', () => {
    expect(parseCsv('﻿a,b\n1,2')[0]).toEqual(['a', 'b']);
  });

  it('引用の中のカンマで列がずれない', () => {
    const rows = parseCsv('氏名,住所\n山田,"東京都港区1,2,3"');
    expect(rows[1]).toEqual(['山田', '東京都港区1,2,3']);
  });

  it('引用の中の改行を1セルとして扱う', () => {
    const rows = parseCsv('a,b\n"1\n2",3');
    expect(rows[1]).toEqual(['1\n2', '3']);
  });

  it('二重引用符をエスケープとして戻す', () => {
    expect(parseCsv('a\n"say ""hi"""')[1]).toEqual(['say "hi"']);
  });

  it('CRLF でも行が割れない', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('末尾に改行が無くても最終行を落とさない', () => {
    expect(parseCsv('a\n1')).toEqual([['a'], ['1']]);
  });

  it('空行は落とす', () => {
    expect(parseCsv('a\n\n1\n\n')).toEqual([['a'], ['1']]);
  });
});

describe('checkCsvDefects（9-4 ①）', () => {
  it('過不足のないCSVは指摘なし', () => {
    const csv = `${header}\n山田 太郎,ヤマダ タロウ,100-0001,東京都千代田区1-1`;
    expect(checkCsvDefects(csv, schema)).toEqual([]);
  });

  it('必須列そのものが無ければ指摘する', () => {
    const csv = '氏名,住所\n山田 太郎,東京都';
    const findings = checkCsvDefects(csv, schema);
    expect(findings).toContainEqual(expect.objectContaining({
      row: 0, column: '郵便番号', type: 'missing',
    }));
  });

  it('任意列が無くても指摘しない', () => {
    const csv = '氏名,郵便番号,住所\n山田 太郎,100-0001,東京都';
    const findings = checkCsvDefects(csv, schema);
    expect(findings.filter((f) => f.column === 'ふりがな')).toEqual([]);
  });

  it('必須項目の未入力を行番号つきで指摘する', () => {
    const csv = `${header}\n山田 太郎,,100-0001,\n佐藤 花子,サトウ,100-0002,東京都`;
    const findings = checkCsvDefects(csv, schema);
    expect(findings).toContainEqual(expect.objectContaining({
      row: 1, column: '住所', type: 'missing',
    }));
    // ふりがなは任意なので指摘しない
    expect(findings.filter((f) => f.column === 'ふりがな')).toEqual([]);
  });

  it('行番号はヘッダーを含めず1始まり', () => {
    const csv = `${header}\n山田,ヤマダ,100-0001,東京都\n佐藤,サトウ,,大阪府`;
    const findings = checkCsvDefects(csv, schema);
    expect(findings[0].row).toBe(2);
  });

  it('形式違反を設定の文言で指摘する', () => {
    const csv = `${header}\n山田 太郎,ヤマダ,1000001234,東京都`;
    const findings = checkCsvDefects(csv, schema);
    expect(findings).toContainEqual(expect.objectContaining({
      row: 1, column: '郵便番号', type: 'inconsistent_notation',
      detail: '郵便番号は7桁でご記入ください',
    }));
  });

  it('ハイフンの有無はどちらも許す（設定した正規表現のとおり）', () => {
    const csv = `${header}\n山田,ヤマダ,1000001,東京都\n佐藤,サトウ,100-0002,大阪府`;
    expect(checkCsvDefects(csv, schema).filter((f) => f.column === '郵便番号')).toEqual([]);
  });

  it('未入力の必須項目には形式違反を重ねて出さない', () => {
    const csv = `${header}\n山田,ヤマダ,,東京都`;
    const findings = checkCsvDefects(csv, schema).filter((f) => f.column === '郵便番号');
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('missing');
  });

  it('重複行を最初の出現行とともに指摘する', () => {
    const csv = `${header}\n山田 太郎,ヤマダ,100-0001,東京都\n佐藤,サトウ,100-0002,大阪府\n山田 太郎,ヤマダ,100-0003,京都府`;
    const findings = checkCsvDefects(csv, schema);
    expect(findings).toContainEqual(expect.objectContaining({
      row: 3, type: 'duplicate', detail: '1行目と同じ内容です',
    }));
  });

  it('行数の上限を超えたら指摘する', () => {
    const rows = Array.from({ length: 6 }, (_, i) => `氏名${i},カナ,100-000${i},住所`);
    const findings = checkCsvDefects([header, ...rows].join('\n'), schema);
    expect(findings).toContainEqual(expect.objectContaining({
      row: 0, type: 'duplicate', detail: expect.stringContaining('5行を超えています'),
    }));
  });

  it('空のファイルは読み取れなかったこととして指摘する', () => {
    const findings = checkCsvDefects('', schema);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('読み取れませんでした');
  });

  it('壊れた正規表現の設定では指摘を出さない（利用者に見せても直せない）', () => {
    const broken: CsvSchemaDefinition = {
      columns: [{ name: '氏名', required: true, pattern: '[' }],
      uniqueBy: [],
    };
    expect(checkCsvDefects('氏名\n山田', broken)).toEqual([]);
  });

  it('ルールベースの指摘は確信度1（決定的に判定できる）', () => {
    const csv = `${header}\n山田,,,東京都`;
    for (const finding of checkCsvDefects(csv, schema)) {
      expect(finding.confidence).toBe(1);
    }
  });

  it('引用の中のカンマを含む住所で誤検出しない', () => {
    const csv = `${header}\n山田 太郎,ヤマダ,100-0001,"東京都千代田区1-1, ○○ビル 3F"`;
    expect(checkCsvDefects(csv, schema)).toEqual([]);
  });
});
