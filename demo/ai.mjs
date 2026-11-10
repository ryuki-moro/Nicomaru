/**
 * デモ用AI（ログイン不要デモ専用、ブラウザ内完結）。
 *
 * 本番の AI 補助（基本設計 9-1〜9-5、本体は src/lib/ai/）を、実LLMを使わず
 * ルールとテンプレートだけで再現したもの。外部送信は一切しない。
 *
 * - 9-1 分類: キーワード辞書のスコアリング（ラベル集合は src/lib/ai/schemas.ts と同じ10種）
 * - 9-3 文面下書き: 目的別テンプレートへ案件データを差し込む
 * - 9-2 準備シート下書き: 案件の状況をテンプレートで要約する
 * - 9-4 不備チェック: src/lib/ai/defectCheck.ts のルールベース①を素のJSへ移植
 * - 9-5 宿題起票案: 打ち合わせメモの文分割＋期限表現の抽出
 *
 * どの関数も「案を返すだけ」で、保存・送信・確定はしない。
 * 画面側が人の操作（採用ボタン）で初めて本文へ反映する。
 */

// ------------------------------------------------------------------ 9-1 分類
/** src/lib/ai/schemas.ts の CLASSIFICATION_LABELS と同じ集合・同じ順序。 */
export const CLASSIFICATION_LABELS = [
  '日程',
  '費用',
  '衣装',
  '料理・飲物',
  '装花・装飾',
  '写真・映像',
  '招待客・席次',
  '進行・演出',
  '支払い・手続き',
  'その他',
];

/** ラベルごとの手がかり語。部分一致で数える（決定的・再現可能）。 */
export const CLASSIFICATION_KEYWORDS = {
  日程: [
    '日程',
    '日時',
    '日付',
    '何時',
    '時間',
    'スケジュール',
    '延期',
    '変更したい日',
    '月',
    '曜日',
  ],
  費用: ['費用', '料金', '値段', '見積', '予算', '高い', '割引', '追加料金', 'いくら'],
  衣装: ['衣装', 'ドレス', 'タキシード', '着物', '試着', 'サイズ', '小物', 'ベール'],
  '料理・飲物': [
    '料理',
    'コース',
    '飲物',
    'ドリンク',
    'ケーキ',
    'アレルギー',
    'メニュー',
    '試食',
    'お酒',
  ],
  '装花・装飾': ['装花', '花', 'ブーケ', '装飾', '飾り', 'テーブルクロス', 'キャンドル'],
  '写真・映像': ['写真', 'カメラ', '映像', '撮影', 'ビデオ', 'アルバム', 'フォト'],
  '招待客・席次': [
    '招待',
    'ゲスト',
    '席次',
    '席',
    '人数',
    '招待状',
    '親族',
    '友人',
    'お子様',
    '子供',
  ],
  '進行・演出': ['進行', '演出', 'BGM', '曲', '入場', '退場', '歓談', 'スピーチ', '余興', '司会'],
  '支払い・手続き': ['支払', '振込', '請求', '契約', '手続き', 'キャンセル', '申込'],
  その他: [],
};

/**
 * 自由記述を分類する（9-1 相当）。
 * キーワードの出現数をラベルごとに数え、多い順に最大3件まで返す。
 * 手がかりが無い文章は「その他」（確信度は低めに置く）。
 */
export function classifyText(text) {
  const value = String(text ?? '');
  const scores = CLASSIFICATION_LABELS.map((label) => {
    let score = 0;
    for (const keyword of CLASSIFICATION_KEYWORDS[label]) {
      let index = value.indexOf(keyword);
      while (index !== -1) {
        score += 1;
        index = value.indexOf(keyword, index + keyword.length);
      }
    }
    return { label, score };
  });
  const total = scores.reduce((sum, entry) => sum + entry.score, 0);
  if (total === 0) return { labels: ['その他'], confidence: 0.3, scores };
  const ranked = scores
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        CLASSIFICATION_LABELS.indexOf(a.label) - CLASSIFICATION_LABELS.indexOf(b.label),
    );
  const labels = ranked.slice(0, 3).map((entry) => entry.label);
  // 確信度は「一番多いラベルの占有率」を 0.45〜0.95 に写した説明可能な値。
  const confidence = Math.round((0.45 + 0.5 * (ranked[0].score / total)) * 100) / 100;
  return { labels, confidence, scores };
}

// ------------------------------------------------------------- 9-3 文面下書き
export const DRAFT_PURPOSES = {
  confirm: '確認OK',
  return: '差し戻しのお願い',
  remind: '提出の催促',
  thanks: 'お礼',
};

/**
 * プランナーから新郎新婦へ送る文面の下書き（9-3 相当）。
 * テンプレートに案件データ（お名前・宿題名・期限）を差し込むだけ。
 * 断定できない点は cautions に残し、人が確認してから使う前提にする。
 *
 * input: { purpose, coupleName, taskTitle, dueDateLabel, detail}
 * detail は差し戻し理由など、人が補う具体内容（任意）。
 */
export function draftMessage(input = {}) {
  const purpose = Object.hasOwn(DRAFT_PURPOSES, input.purpose) ? input.purpose : 'return';
  const couple = String(input.coupleName ?? '').trim() || 'お二人';
  const task = String(input.taskTitle ?? '').trim() || '宿題';
  const due = String(input.dueDateLabel ?? '').trim();
  const detail = String(input.detail ?? '').trim();
  const cautions = [];
  if (!due) cautions.push('期限が未設定のため、下書きに期限は含まれていません');
  if (purpose === 'return' && !detail)
    cautions.push('修正してほしい具体的な内容は下書きに含まれていません。送信前に追記してください');
  if (purpose === 'remind' && !due)
    cautions.push('催促の文面ですが期限が分かりません。期限を確認してから送ってください');

  let text;
  if (purpose === 'confirm') {
    text = `${couple} 様\n\n「${task}」のご提出ありがとうございました。内容を確認し、問題ありませんでした。\n引き続き、他の準備もよろしくお願いいたします。`;
  } else if (purpose === 'remind') {
    text = `${couple} 様\n\n「${task}」のご提出をお待ちしております。${due ? `\n期限は ${due} です。` : ''}\nご不明な点があれば、お気軽にご連絡ください。`;
  } else if (purpose === 'thanks') {
    text = `${couple} 様\n\nこのたびは「${task}」のご提出ありがとうございました。\n内容はプランナーが確認いたします。結果はあらためてご連絡します。`;
  } else {
    text = `${couple} 様\n\n「${task}」のご提出ありがとうございました。内容を確認したところ、修正をお願いしたい点がありました。${detail ? `\n${detail}` : ''}\nお手数ですが、${due ? `${due} までに ` : ''}修正のうえ再提出をお願いいたします。`;
  }
  return { text, cautions };
}

// ------------------------------------------------- 9-2 準備シート下書き（要点）
/**
 * 打ち合わせ前準備シートの要点下書き（9-2 相当）。
 * 案件の状況（未提出・確認待ち・メモ）をテンプレートで文章化する。
 * input: { coupleName, weddingDateLabel, plan, guestCount,
 * pending: [{title, dueDateLabel}], submitted: [{title}], notes}
 */
export function draftMeetingSheet(input = {}) {
  const couple = String(input.coupleName ?? '').trim() || 'お二人';
  const pending = Array.isArray(input.pending) ? input.pending : [];
  const submitted = Array.isArray(input.submitted) ? input.submitted : [];
  const cautions = [];
  const lines = [
    ``,
    `${couple} 様 / 挙式日 ${String(input.weddingDateLabel ?? '')} / ${String(input.plan ?? '')} / ゲスト ${input.guestCount ?? ''}名`,
  ];
  if (pending.length) {
    lines.push(
      `・未提出の宿題は ${pending.length} 件です。次回はまず ${pending[0].title}（期限 ${pending[0].dueDateLabel ?? ''}）の状況を確認します。`,
    );
  } else lines.push('・未提出の宿題はありません。');
  if (submitted.length) {
    lines.push(
      `・確認待ちの提出は ${submitted.length} 件です（${submitted.map((t) => t.title).join('、')}）。内容を確認し、結果をお伝えします。`,
    );
  } else lines.push('・確認待ちの提出はありません。');
  const notes = String(input.notes ?? '').trim();
  if (notes) {
    const classified = classifyText(notes);
    lines.push(`・打ち合わせメモの主な話題: ${classified.labels.join('、')}（自動分類）`);
    lines.push(`・メモ: ${notes}`);
  } else cautions.push('打ち合わせメモが空のため、話題の自動分類は行っていません');
  if (pending.some((t) => t.overdue))
    cautions.push('期限を過ぎた宿題があります。当日は理由と新しい期限を一緒に確認してください');
  return { text: lines.join('\n'), cautions };
}

// ------------------------------------------- 9-4 不備チェック（ルールベース①）
/**
 * src/lib/ai/defectCheck.ts の parseCsv を素のJSへ移植したもの。
 * RFC 4180 の引用（"" エスケープ、引用内の改行・カンマ）に対応する。
 */
export function parseCsv(text) {
  const input = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r') {
      if (input[i + 1] !== '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      }
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export const DEFECT_TYPE_LABEL = {
  missing: '未入力',
  duplicate: '重複',
  inconsistent_notation: '表記ゆれ',
  honorific: '敬称',
};

/** デモで使うゲストリスト向けの既定の列定義（本番では宿題ごとに設定する）。 */
export const GUEST_CSV_SCHEMA = {
  columns: [
    { name: '氏名', required: true },
    {
      name: '郵便番号',
      required: false,
      pattern: '^\\d{3}-?\\d{4}$',
      patternHint: '「郵便番号」は 123-4567 の形式でご確認ください',
    },
    {
      name: '電話番号',
      required: false,
      pattern: '^[0-9-]+$',
      patternHint: '「電話番号」は数字とハイフンだけでご確認ください',
    },
  ],
  uniqueBy: ['氏名'],
  maxRows: 300,
};

/**
 * src/lib/ai/defectCheck.ts の checkCsvDefects を素のJSへ移植したもの（①のみ）。
 * 検出は決定的なものだけ：必須列の欠損・必須値の空欄・形式違反・行数・重複。
 * schema: { columns: [{name, required?, pattern?, patternHint?}], uniqueBy?, maxRows?}
 */
export function checkCsvDefects(csvText, schema = GUEST_CSV_SCHEMA) {
  const columns = Array.isArray(schema?.columns) ? schema.columns : [];
  const uniqueBy = Array.isArray(schema?.uniqueBy) ? schema.uniqueBy : [];
  const findings = [];
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    findings.push({
      row: 0,
      column: '',
      type: 'missing',
      detail: '中身が読み取れませんでした。ファイルをご確認ください',
      confidence: 1,
    });
    return findings;
  }
  const header = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1);
  const indexOf = new Map();
  for (const column of columns) {
    const index = header.indexOf(column.name);
    if (index === -1) {
      if (column.required)
        findings.push({
          row: 0,
          column: column.name,
          type: 'missing',
          detail: `「${column.name}」の列が見つかりません`,
          confidence: 1,
        });
      continue;
    }
    indexOf.set(column.name, index);
  }
  if (schema?.maxRows !== undefined && dataRows.length > schema.maxRows) {
    findings.push({
      row: 0,
      column: '',
      type: 'duplicate',
      detail: `行数が${schema.maxRows}行を超えています（${dataRows.length}行）`,
      confidence: 1,
    });
  }
  dataRows.forEach((cells, i) => {
    const rowNo = i + 1;
    for (const column of columns) {
      const index = indexOf.get(column.name);
      if (index === undefined) continue;
      const value = (cells[index] ?? '').trim();
      if (column.required && value === '') {
        findings.push({
          row: rowNo,
          column: column.name,
          type: 'missing',
          detail: `「${column.name}」が未入力です`,
          confidence: 1,
        });
        continue;
      }
      if (value !== '' && column.pattern) {
        let matches = true;
        try {
          matches = new RegExp(column.pattern).test(value);
        } catch {
          continue;
        }
        if (!matches)
          findings.push({
            row: rowNo,
            column: column.name,
            type: 'inconsistent_notation',
            detail: column.patternHint ?? `「${column.name}」の形式をご確認ください`,
            confidence: 1,
          });
      }
    }
  });
  if (uniqueBy.length > 0) {
    const seen = new Map();
    dataRows.forEach((cells, i) => {
      const rowNo = i + 1;
      const key = uniqueBy
        .map((name) => {
          const index = indexOf.get(name);
          return index === undefined ? '' : (cells[index] ?? '').trim();
        })
        .join(' ');
      if (key.replaceAll(' ', '') === '') return;
      const first = seen.get(key);
      if (first !== undefined)
        findings.push({
          row: rowNo,
          column: uniqueBy.join('・'),
          type: 'duplicate',
          detail: `${first}行目と同じ内容です`,
          confidence: 1,
        });
      else seen.set(key, rowNo);
    });
  }
  return findings;
}

/** 提出テキストがCSVらしいか（1行目にカンマがあり、複数行ある）。 */
export function looksLikeCsv(text) {
  const value = String(text ?? '');
  return (
    value.includes(',') &&
    value
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim()).length >= 2
  );
}

// ------------------------------------------------------------- 9-5 宿題起票案
const DUE_PATTERNS = [
  /(\d{1,2})月(\d{1,2})日(?:まで|頃|ごろ|に)?/,
  /挙式の?(\d+)か月前(?:まで|頃|ごろ)?/,
  /挙式の?(\d+)週間前(?:まで|頃|ごろ)?/,
  /(\d{1,2})月(?:末|上旬|中旬|下旬)(?:まで)?/,
  /(来週|今週|来月|今月|月末)(?:まで)?/,
];

/** 文から期限の目安表現を1つ取り出す。無ければ ''。 */
export function extractDueHint(sentence) {
  for (const pattern of DUE_PATTERNS) {
    const match = String(sentence).match(pattern);
    if (match) return match[0].replace(/まで$/, 'まで');
  }
  return '';
}

/**
 * 打ち合わせメモから宿題の起票案を作る（9-5 相当）。
 * 文ごとに分け、期限表現を due_hint として抜き出し、残りを題名の材料にする。
 * 戻り値は本番スキーマ（taskExtractionOutputSchema）と同じ形 { tasks: [{title, description, due_hint}]}。
 */
export function extractTaskProposals(memo) {
  const sentences = String(memo ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/[。\n！？!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  const tasks = [];
  const seen = new Set();
  for (const sentence of sentences) {
    const due_hint = extractDueHint(sentence);
    let title = sentence
      .replace(/(\d{1,2})月(\d{1,2})日(?:まで|頃|ごろ|に)?/g, '')
      .replace(/挙式の?\d+か月前(?:まで|頃|ごろ)?/g, '')
      .replace(/挙式の?\d+週間前(?:まで|頃|ごろ)?/g, '')
      .replace(
        /(してください|をお願いします|お願いします|すること|しましょう|ます|です)[。\s]*$/g,
        '',
      )
      .replace(/^[、・\s]+|[、・\s]+$/g, '')
      .trim();
    if (title.length > 40) title = `${title.slice(0, 40)}…`;
    if (!title) title = sentence.slice(0, 40);
    if (seen.has(title)) continue;
    seen.add(title);
    tasks.push({ title, description: sentence, due_hint });
    if (tasks.length >= 10) break;
  }
  return { tasks };
}

/**
 * due_hint を挙式日から具体的な日付（YYYY-MM-DD）へ寄せる。
 * 「挙式Nか月前」は30日×N の近似、「M月D日」は挙式年を使う。
 * 解釈できない表現は null（画面側で挙式30日前などの既定に倒す）。
 */
export function resolveProposalDate(dueHint, weddingDate) {
  const hint = String(dueHint ?? '');
  const base = new Date(`${weddingDate}T00:00:00Z`);
  if (!Number.isFinite(base.getTime())) return null;
  const shift = (days) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  let match = hint.match(/挙式の?(\d+)か月前/);
  if (match) return shift(-30 * Number(match[1]));
  match = hint.match(/挙式の?(\d+)週間前/);
  if (match) return shift(-7 * Number(match[1]));
  match = hint.match(/(\d{1,2})月(\d{1,2})日/);
  if (match) {
    const candidate = `${base.getUTCFullYear()}-${String(match[1]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;
    const parsed = new Date(`${candidate}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
      ? candidate
      : null;
  }
  return null;
}
