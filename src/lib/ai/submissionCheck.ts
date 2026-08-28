/**
 * 提出物の不備一次チェック（機能9-4）のサーバー側入口。
 *
 * 正本: 基本設計書 7-2。
 *
 *   「9-4 の検査は2段に分ける。
 *     ①ルールベース（必須列の欠損・行内重複・文字種／桁の形式違反・行数チェック）は
 *       決定的に判定できるためコードで実装する。
 *     ②ローカルLLMは表記ゆれ候補と敬称の疑いのみを、該当行番号と確信度付きで提示する。
 *     ②の精度が不足した場合は①のみで運用する（縮退案。第13章）」
 *   「提出CSVの期待列は task_templates.default_options のスキーマとして定義する」
 *
 * ①は D02 を開くたびに毎回かける。保存しないのは、
 * 検査ルール（case_tasks.options.csvSchema）を直したときに古い結果が残ると
 * 画面と設定が食い違うため。CSV は上限300行程度で、都度の解析でも負荷にならない。
 *
 * ②へ渡すテキストはここで削る。7-4「LLMへの入力は処理に必要な最小限の項目に限定する」に従い、
 * 検査対象の列だけを行番号つきで抜き出す（電話番号や住所を丸ごと渡さない）。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { AI_INPUT_TEXT_MAX } from '@/lib/ai/assist';
import {
  checkCsvDefects,
  csvSchemaDefinition,
  parseCsv,
  type CsvSchemaDefinition,
  type DefectFinding,
} from '@/lib/ai/defectCheck';

/** CSV として扱う条件。拡張子と MIME の両方を見る（ブラウザによって MIME が空になる）。 */
function looksLikeCsv(fileName: string | null, mimeType: string | null): boolean {
  if (mimeType && /csv|text\/plain/i.test(mimeType)) return true;
  return /\.csv$/i.test(fileName ?? '');
}

/**
 * 宿題の設定から期待列スキーマを取り出す。
 * 設定が無い・形が違う宿題では①を行わない（勝手な列名を仮定しない）。
 */
export function csvSchemaOf(options: Record<string, unknown> | null): CsvSchemaDefinition | null {
  const raw = options?.csvSchema;
  if (raw == null) return null;
  const parsed = csvSchemaDefinition.safeParse(raw);
  if (!parsed.success) {
    console.warn('[ai] csvSchema の形式が正しくありません', parsed.error.issues);
    return null;
  }
  return parsed.data;
}

export interface CsvCheckResult {
  /** ①ルールベースの指摘 */
  findings: DefectFinding[];
  /** ②へ渡す、検査対象列だけに絞った本文 */
  llmInput: string;
  rowCount: number;
}

export interface SubmissionFileRef {
  bucket: string;
  objectPath: string;
  fileName: string | null;
  mimeType: string | null;
}

/**
 * ②へ渡す本文を作る。
 *
 * 表記ゆれ・敬称の判定に要るのは「文字列として書かれた値」なので、
 * schema.columns のうち pattern を持たない列（＝氏名・住所のような自由入力）に絞る。
 * pattern 付きの列（郵便番号・電話番号）は①が決定的に判定できるうえ、
 * 表記ゆれの対象にもならないため渡さない。
 */
function buildLlmInput(rows: string[][], schema: CsvSchemaDefinition): string {
  if (rows.length === 0) return '';
  const header = rows[0].map((h) => h.trim());
  const targets = schema.columns
    .filter((c) => c.pattern === undefined)
    .map((c) => ({ name: c.name, index: header.indexOf(c.name) }))
    .filter((c) => c.index !== -1);
  if (targets.length === 0) return '';

  const lines = [targets.map((t) => t.name).join(',')];
  rows.slice(1).forEach((cells, i) => {
    lines.push(`${i + 1},${targets.map((t) => (cells[t.index] ?? '').trim()).join(',')}`);
  });

  const text = lines.join('\n');
  // 招待客リストが長いと入力上限を超える。超えた分は渡さず、②は前半だけの疑い提示になる。
  // ①は全行にかかっているので、切れても決定的な指摘は落ちない（7-2 の縮退案と同じ考え方）。
  return text.length > AI_INPUT_TEXT_MAX ? text.slice(0, AI_INPUT_TEXT_MAX) : text;
}

/**
 * 提出ファイルを取得して①をかける。
 *
 * 取得できない・CSV でない・スキーマ未設定のいずれでも null を返す。
 * 9-4 は補助なので、ここで失敗しても D02 の本体（提出内容の確認）は表示できる必要がある。
 */
export async function checkSubmittedCsv(
  supabase: SupabaseClient,
  file: SubmissionFileRef,
  schema: CsvSchemaDefinition,
): Promise<CsvCheckResult | null> {
  if (!looksLikeCsv(file.fileName, file.mimeType)) return null;

  const { data, error } = await supabase.storage.from(file.bucket).download(file.objectPath);
  if (error || !data) {
    console.warn('[ai] 提出ファイルを取得できませんでした', file.objectPath, error);
    return null;
  }

  // Excel が出力する CSV は BOM 付き UTF-8 が多い。BOM が残ると先頭列名が一致しない。
  const text = (await data.text()).replace(/^﻿/, '');
  const rows = parseCsv(text);

  return {
    findings: checkCsvDefects(text, schema),
    llmInput: buildLlmInput(rows, schema),
    rowCount: Math.max(0, rows.length - 1),
  };
}
