import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASSIFICATION_LABELS,
  classifyText,
  draftMessage,
  draftMeetingSheet,
  parseCsv,
  checkCsvDefects,
  looksLikeCsv,
  extractTaskProposals,
  extractDueHint,
  resolveProposalDate,
} from '../../demo/ai.mjs';
import { seedData } from '../../demo/data.mjs';
import {
  validState,
  adoptAiLabels,
  adoptAiSheetDraft,
  addTaskProposals,
} from '../../demo/model.mjs';

const now = new Date('2026-10-09T03:00:00Z');

test('分類: キーワードの多い話題が先頭になり、ラベルは10種の範囲内', () => {
  const result = classifyText('料理コースとケーキ、飲物の内容を相談したいです');
  assert.equal(result.labels[0], '料理・飲物');
  assert.ok(result.labels.every((label) => CLASSIFICATION_LABELS.includes(label)));
  assert.ok(result.confidence > 0.5 && result.confidence <= 0.95);
  const schedule = classifyText('日程を変更したい。何時から始まりますか');
  assert.equal(schedule.labels[0], '日程');
  const guests = classifyText('ゲストの人数と席次を確認したい');
  assert.equal(guests.labels[0], '招待客・席次');
});

test('分類: 手がかりが無い文章は「その他」で確信度が低い', () => {
  const result = classifyText('よろしくお願いします');
  assert.deepEqual(result.labels, ['その他']);
  assert.ok(result.confidence < 0.5);
  assert.deepEqual(classifyText('').labels, ['その他']);
});

test('文面下書き: 目的別テンプレートに案件データが差し込まれ、注意点が返る', () => {
  const draft = draftMessage({
    purpose: 'return',
    coupleName: '青木 翔太・青木 美咲',
    taskTitle: 'BGMリクエスト',
    dueDateLabel: '2026年11月3日',
  });
  assert.match(draft.text, /青木 翔太・青木 美咲/);
  assert.match(draft.text, /BGMリクエスト/);
  assert.match(draft.text, /2026年11月3日 までに/);
  // 具体内容が無い差し戻しは、追記が必要なことを注意点で返す
  assert.ok(draft.cautions.some((c) => c.includes('追記')));
  const withDetail = draftMessage({
    purpose: 'return',
    coupleName: '石井 健太・石井 結衣',
    taskTitle: 'ゲストリスト提出',
    dueDateLabel: '2026年11月10日',
    detail: 'お子様の人数を教えてください。',
  });
  assert.match(withDetail.text, /お子様の人数/);
  assert.equal(withDetail.cautions.length, 0);
  const confirm = draftMessage({
    purpose: 'confirm',
    coupleName: '岡田',
    taskTitle: '席次表の確認',
  });
  assert.match(confirm.text, /問題ありませんでした/);
  const remind = draftMessage({ purpose: 'remind', coupleName: '小川', taskTitle: '衣装' });
  assert.ok(remind.cautions.some((c) => c.includes('期限')));
});

test('準備シート下書き: 未提出・確認待ち・メモの分類が文章になる', () => {
  const sheet = draftMeetingSheet({
    coupleName: '青木 翔太・青木 美咲',
    weddingDateLabel: '2026年11月3日',
    plan: '少人数婚',
    guestCount: 18,
    pending: [{ title: 'ゲストリスト提出', dueDateLabel: '2026年10月20日', overdue: true }],
    submitted: [{ title: 'BGMリクエスト' }],
    notes: '衣装と撮影のイメージを相談しましょう。',
  });
  assert.match(sheet.text, /未提出の宿題は 1 件/);
  assert.match(sheet.text, /確認待ちの提出は 1 件/);
  assert.match(sheet.text, /衣装/);
  assert.ok(sheet.cautions.some((c) => c.includes('期限を過ぎた')));
});

test('不備チェック: CSV解析は引用とカンマを含む住所を壊さない', () => {
  const rows = parseCsv('氏名,住所\n"架空, 太郎","東京都, 架空市"\n架空 花子,架空市');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0], '架空, 太郎');
  assert.equal(rows[1][1], '東京都, 架空市');
});

test('不備チェック: 必須空欄・必須列欠損・形式違反・重複を決定的に判定する', () => {
  const schema = {
    columns: [
      { name: '氏名', required: true },
      {
        name: '郵便番号',
        required: true,
        pattern: '^\\d{3}-?\\d{4}$',
        patternHint: '郵便番号の形式',
      },
    ],
    uniqueBy: ['氏名'],
    maxRows: 10,
  };
  const findings = checkCsvDefects(
    '氏名,郵便番号\n架空 太郎,123-4567\n,999\n架空 太郎,123-4567',
    schema,
  );
  const byType = (type) => findings.filter((f) => f.type === type);
  assert.equal(byType('missing').length, 1); // 2行目の氏名が空
  assert.equal(byType('missing')[0].row, 2);
  assert.equal(byType('inconsistent_notation').length, 1); // 999 は形式違反
  assert.equal(byType('duplicate').length, 1); // 3行目は1行目と重複
  assert.ok(findings.every((f) => f.confidence === 1));

  const noColumn = checkCsvDefects('名前\n架空 太郎', schema);
  assert.ok(noColumn.some((f) => f.type === 'missing' && f.column === '氏名' && f.row === 0));
  assert.deepEqual(checkCsvDefects('氏名,郵便番号\n架空 太郎,123-4567', schema), []);
  const tooMany = checkCsvDefects(
    `氏名,郵便番号\n${Array.from({ length: 11 }, (_, i) => `架空${i} 太郎,123-4567`).join('\n')}`,
    schema,
  );
  assert.ok(tooMany.some((f) => f.detail.includes('行数')));
  assert.equal(looksLikeCsv('氏名,住所\n架空,東京'), true);
  assert.equal(looksLikeCsv('ただの文章です'), false);
});

test('宿題起票案: 文分割と期限表現の抽出、重複の除去', () => {
  assert.equal(extractDueHint('衣装合わせの日程を12月10日までに決めてください'), '12月10日まで');
  assert.equal(extractDueHint('席次は挙式2か月前までに確定しましょう'), '挙式2か月前まで');
  assert.equal(extractDueHint('特に期限の話はない'), '');
  const { tasks } = extractTaskProposals(
    '衣装合わせの日程を12月10日までに決めてください。席次表は挙式2か月前までに確定しましょう。',
  );
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].due_hint, '12月10日まで');
  assert.match(tasks[0].title, /衣装合わせ/);
  assert.equal(tasks[1].due_hint, '挙式2か月前まで');
  assert.equal(resolveProposalDate('挙式2か月前まで', '2027-03-01'), '2026-12-31');
  assert.equal(resolveProposalDate('12月10日まで', '2026-11-03'), '2026-12-10');
  assert.equal(resolveProposalDate('来週まで', '2026-11-03'), null);
  assert.deepEqual(extractTaskProposals('').tasks, []);
});

test('AI結果は採用操作でだけ state に乗り、検証を通る', () => {
  const state = seedData(now);
  const adopted = adoptAiLabels(state, 'demo-01', 'bgm', ['進行・演出']);
  assert.deepEqual(adopted.cases[0].tasks.find((t) => t.id === 'bgm').aiLabels, ['進行・演出']);
  assert.equal(state.cases[0].tasks.find((t) => t.id === 'bgm').aiLabels, undefined);
  assert.equal(validState(adopted), true);
  assert.throws(() => adoptAiLabels(state, 'demo-01', 'bgm', ['存在しないラベル']));

  const sheet = adoptAiSheetDraft(state, 'demo-01', '要点の下書き');
  assert.equal(sheet.cases[0].aiSheetDraft, '要点の下書き');
  assert.equal(validState(sheet), true);

  const added = addTaskProposals(state, 'demo-01', [
    {
      title: '衣装合わせの日程調整',
      description: '衣装合わせの日程を決める',
      dueDate: '2026-12-10',
    },
  ]);
  assert.equal(added.cases[0].tasks.length, state.cases[0].tasks.length + 1);
  assert.equal(validState(added), true);
  assert.throws(() => addTaskProposals(state, 'demo-01', []));
});
