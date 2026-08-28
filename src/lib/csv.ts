/**
 * CSV 出力。
 *
 * 正本: 基本設計書 Version 1.2 第9章「CSV出力対策」／4-3 S03。
 *
 *   「CSV生成時は先頭が = + - @ タブ CR の値をエスケープする」
 *   「文字コードは UTF-8（BOM付き）、最大10,000件」
 *
 * 【なぜ入力側ではなく出力側で対策するか（3-3-3）】
 * 提出された CSV は原文のまま保存する。入力時にエスケープすると、
 * 新郎新婦が入力した値そのものが書き換わり、提出物として正しくなくなる。
 * 危険なのは「Excel が数式として評価すること」であり、それは出力の瞬間にしか起きない。
 */

/** Excel／Google Sheets が数式の開始とみなす先頭文字（9章）。 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * 1セルぶんをエスケープする。
 *
 * 数式起動文字で始まる値の前にシングルクォートを置く。
 * これは Excel の「以降を文字列として扱う」記法で、表示上は元の値のまま読める。
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);

  if (FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    text = `'${text}`;
  }

  // 区切り・改行・引用符を含む値は引用符で囲み、内部の引用符は2つ重ねる（RFC 4180）
  if (/[",\r\n]/.test(text)) {
    text = `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

/** S03 の「最大10,000件（超過分は期間を絞る）」。 */
export const CSV_MAX_ROWS = 10_000;

export interface CsvOptions {
  /** 超過時に切り詰めた事実を呼び出し側へ返すためのフラグ */
  maxRows?: number;
}

export interface CsvResult {
  /** BOM 付き UTF-8 の本文（4-3 S03） */
  content: string;
  rowCount: number;
  truncated: boolean;
}

/**
 * ヘッダー行つきの CSV を組み立てる。
 *
 * BOM を付けるのは、Excel が BOM 無し UTF-8 を Shift_JIS と誤認して
 * 日本語が文字化けするため（4-3 S03 が「UTF-8（BOM付き）」と定めている理由）。
 */
export function buildCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  options: CsvOptions = {},
): CsvResult {
  const max = options.maxRows ?? CSV_MAX_ROWS;
  const limited = rows.slice(0, max);

  const lines = [
    headers.map(escapeCsvCell).join(','),
    ...limited.map((row) => row.map(escapeCsvCell).join(',')),
  ];

  return {
    content: `﻿${lines.join('\r\n')}\r\n`,
    rowCount: limited.length,
    truncated: rows.length > max,
  };
}
