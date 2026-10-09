import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// 編集する正本は JSON。集計と Markdown を同じデータから再生成する。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'docs/implementation-progress.json');
const output = resolve(root, 'docs/実装進捗一覧.md');
const data = JSON.parse(readFileSync(source, 'utf8'));
const labels = data.statusLabels;
const ids = new Set();
const fail = (message) => {
  throw new Error(message);
};
for (const task of data.tasks) {
  if (ids.has(task.id)) fail(`重複ID: ${task.id}`);
  ids.add(task.id);
  if (!labels[task.status]) fail(`不明な状態: ${task.id}`);
  if (!task.title || !task.design || !task.note) fail(`説明不足: ${task.id}`);
  if (task.status !== 'main' && !task.next) fail(`残作業なし: ${task.id}`);
  for (const path of task.evidence) {
    if (!existsSync(resolve(root, path))) fail(`根拠ファイルなし: ${task.id} ${path}`);
  }
  for (const number of task.issues) {
    if (!data.issues.some((i) => i.number === number)) fail(`不明なIssue: ${task.id} #${number}`);
  }
  for (const number of task.prs) {
    if (!data.pullRequests.some((p) => p.number === number))
      fail(`不明なPR: ${task.id} #${number}`);
  }
}
for (const task of data.tasks) {
  for (const id of task.dependsOn) if (!ids.has(id)) fail(`不明な依存: ${task.id} ${id}`);
  if (task.targetMonth) {
    const month = data.schoolSchedule?.months.find((m) => m.month === task.targetMonth);
    if (!month || month.latestBy !== task.latestBy || !task.ownerMode || !task.workMode)
      fail(`学校日程・担当区分の不足: ${task.id}`);
  }
}
const schedule = data.schoolSchedule;
if (schedule) {
  if (!data.issues.some((i) => i.number === schedule.epic)) fail('学校Epicが未登録');
  const expectedMonths = ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
  if (schedule.months.map((m) => m.month).join(',') !== expectedMonths.join(','))
    fail('学校の対象月が不一致');
  for (const month of schedule.months) {
    const [year, number] = month.month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
    if (month.latestBy !== lastDay) fail(`月末目安が不一致: ${month.month}`);
    if (!month.milestone || !month.milestoneUrl || !month.activities || !month.deliverables)
      fail(`学校成果物の説明不足: ${month.month}`);
    for (const issue of month.issues) {
      if (!data.issues.some((i) => i.number === issue)) fail(`月別Issueが未登録: #${issue}`);
      if (!data.tasks.some((t) => t.issues.includes(issue) && t.targetMonth === month.month))
        fail(`月別Issueと台帳の対応不足: #${issue}`);
    }
  }
}
const visiting = new Set();
const visited = new Set();
const byId = new Map(data.tasks.map((t) => [t.id, t]));
function visit(id) {
  if (visiting.has(id)) fail(`依存が循環: ${id}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dep of byId.get(id).dependsOn) visit(dep);
  visiting.delete(id);
  visited.add(id);
}
for (const id of ids) visit(id);
const featureIds = [6, 6, 5, 5, 5, 3, 3, 5, 11].flatMap((n, index) =>
  Array.from({ length: n }, (_, j) => `F-${index + 1}-${j + 1}`),
);
for (const id of featureIds) if (!ids.has(id)) fail(`機能の対応漏れ: ${id}`);
if (data.tasks.filter((t) => t.kind === 'feature').length !== featureIds.length)
  fail('機能数不一致');
const screenIds = [
  ['P', 4],
  ['M', 6],
  ['K', 5],
  ['D', 5],
  ['T', 3],
  ['U', 4],
  ['N', 1],
  ['S', 3],
].flatMap(([p, n]) => Array.from({ length: n }, (_, j) => `${p}${String(j + 1).padStart(2, '0')}`));
if (
  data.screens.length !== screenIds.length ||
  new Set(data.screens.map((s) => s.id)).size !== screenIds.length
)
  fail('画面数不一致');
for (const id of screenIds)
  if (!data.screens.some((s) => s.id === id)) fail(`画面の対応漏れ: ${id}`);
for (const screen of data.screens)
  if (!existsSync(resolve(root, screen.file))) fail(`画面ファイルなし: ${screen.id}`);
const counts = (tasks) =>
  Object.keys(labels).map((s) => tasks.filter((t) => t.status === s).length);
const groups = [...new Set(data.tasks.map((t) => t.category))];
const core = data.tasks.filter((t) => t.kind === 'feature' && t.scope === 'active');
const workItems = data.tasks.filter((t) => t.kind === 'work_item');
const pageFileCount = readdirSync(resolve(root, 'src/app'), { recursive: true }).filter((path) =>
  /(^|[\\/])page\.tsx$/.test(path),
).length;
const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>');
const anchor = (id) => `task-${id.toLowerCase()}`;
const taskLink = (id) => `[${id}](#${anchor(id)})`;
const issueLink = (n) => `[#${n}](https://github.com/${data.repository}/issues/${n})`;
const prLink = (n) => `[PR #${n}](https://github.com/${data.repository}/pull/${n})`;
const evidenceLink = (path) => {
  const target = relative(dirname(output), resolve(root, path)).replaceAll('\\', '/');
  return `[${path}](${target})`;
};
const lines = [
  '# にこまる — 実装・学校成果物の進捗一覧',
  '',
  `確認日: **${new Date(data.updatedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })}**（日本時間）。main: \`${data.mainCommit.slice(0, 7)}\`、改善実装: \`${data.implementationCommit.slice(0, 7)}\`。`,
  '',
  '要件定義v1.2・基本設計v1.6の全49機能/31画面ID、コード、Issue/PR、実環境作業記録、CIを照合した台帳。自動試験・模擬負荷・人の試用・共有DBへの適用を区別し、証拠のある対象版と環境だけを完了扱いにする。',
  '',
  `**コア44機能: mainに実装${core.filter((t) => t.status === 'main').length}、マージ待ち${core.filter((t) => t.status === 'review').length}、一部実装${core.filter((t) => t.status === 'partial').length}。条件付き拡張5機能。共通基盤・具体的な残作業・運用・検証・制作の確認項目${workItems.length}件。**`,
  '',
  '機能とその下位の作業・月別成果物が含まれるため、合計項目数を工数や完了率に換算しない。コードの存在、mainへの反映、学校デモ環境での検証、資料の完成は別の判定。アプリの本番運用は現在予定なし。mainに実装は静的照合と既存テストの確認であり、全仕様の合格宣言ではない。',
  '',
  '## 状態の読み方',
  '',
  '| 状態 | 判定 |',
  '| --- | --- |',
  '| mainに実装 | mainに対応コードあり。デモ環境の設定・品質評価は別項目 |',
  '| マージ待ち | 別ブランチ/PRに実装あり、mainは未反映 |',
  '| 一部実装 | 対応コードがあるが仕様・導線・運用の一部が不足 |',
  '| 未着手 | repoに成果物/実装が見つからない。外部の未共有成果物の存在までは判定しない |',
  '| 実施記録あり | 記載した日時・対象版で実行証拠あり。現在の環境や人の試用へ一般化しない |',
  '| 準備完了・実施待ち | 編集可能な成果物・手順・記入欄を用意。学校でのレビューや実施結果は未記入 |',
  '| 人による実施待ち | 実端末・学校の発表・本人の工数など、人が実施/確認する項目 |',
  '| 環境反映待ち | 実装・手順はあるが対象環境への設定/DB反映が未完了 |',
  '| 設定・準備待ち | 関連Issue/記録に残作業。最新の完了証拠が不足 |',
  '| 確認・整理待ち | 実装・記録はあるが検証/Issue整理/実証判定の証拠が不足 |',
  '| 条件付き保留 | 将来運用・拡張の着手条件/採用判断待ち。学校の月別必須成果物に加算しない |',
  '',
  '## 分野ごとの集計',
  '',
  `| 分野 | 項目 | ${Object.values(labels).join(' | ')} |`,
  '| --- | ---: | ' +
    Object.keys(labels)
      .map(() => '---:')
      .join(' | ') +
    ' |',
  ...groups.map((g) => {
    const ts = data.tasks.filter((t) => t.category === g);
    return `| ${g} | ${ts.length} | ${counts(ts).join(' | ')} |`;
  }),
  `| 合計（機能と下位項目を含む） | ${data.tasks.length} | ${counts(data.tasks).join(' | ')} |`,
  '',
  '## 先に進める順序',
  '',
  ...(data.currentPlan ?? []).map((step, index) => `${index + 1}. ${step}`),
  '',
  '成果物: [詳細設計](詳細設計/README.md)、[中間発表](発表/中間発表/README.md)、[試験仕様・評価票](テスト/README.md)、[WBS](WBS/README.md)、[AI不要の操作手順](メンバー向けデモと運用手順.md)、[共有DBの更新](DB更新手順_20261009.md)。',
  '',
  ...data.nextOrder.map(
    (id) => `- ${taskLink(id)} ${byId.get(id).title} — ${labels[byId.get(id).status]}`,
  ),
  '',
  ...(schedule
    ? [
        '## 学校の月別成果物・担当区分',
        '',
        `${issueLink(schedule.epic)}で月別成果物を管理。[学校制作スケジュール](学校制作スケジュール.md)に入力素材・分担・記録方法をまとめた。`,
        '',
        schedule.period,
        '',
        schedule.scope,
        '',
        schedule.roles,
        '',
        '| 月 | 最遅の目安 | 作業・成果物 | Issue |',
        '| --- | --- | --- | --- |',
        ...schedule.months.map(
          (m) =>
            `| ${m.month} | [${m.latestBy}](${m.milestoneUrl}) | ${m.activities}<br>${m.deliverables} | ${m.issues.map(issueLink).join('、')} |`,
        ),
        '',
        '正式な担当者はチームで決める。Agent AI不要の項目は、教材・手順・既存の例・利用可能なOffice等で完了できる。コード作業はCodex使用可だが手動実装も可能。月末より早い学校の提出日/発表日を優先する。WBSの実績記録は10月から開始する。',
        '',
      ]
    : []),
  '## マージ待ち・CI',
  '',
  '| PR | base → head | 状態 |',
  '| --- | --- | --- |',
  ...data.pullRequests.map(
    (p) =>
      `| ${prLink(p.number)} ${p.title} | ${p.base} → \`${p.head.slice(0, 7)}\` | ${p.state}${p.draft ? '（draft）' : ''}。${p.checkSummary ?? '検証結果はPRのChecksを参照'} |`,
  ),
  '',
  `${data.ci.label ?? '記録済み'}の[CI run ${data.ci.run}](${data.ci.url})（${data.ci.date}）: ユニット/RLS **${data.ci.unitRlsPassed}成功**、同じ集計の実PG用${data.ci.pgSkippedInUnit}件はskip。別ジョブで**実PostgreSQL ${data.ci.realPgPassed}成功**。**E2E ${data.ci.e2ePassed}成功**。verify: ${data.ci.verify}、security: ${data.ci.security}、依存監査: ${data.ci.auditVulnerabilities}件。${data.ci.note ?? ''}`,
  '',
  '## 全項目',
  '',
];
for (const group of groups) {
  lines.push(
    `### ${group}`,
    '',
    '| ID・項目 | Phase / 状態 | 設計・画面 | 根拠・現状 | 残作業・前提・Issue/PR |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const t of data.tasks.filter((t) => t.category === group)) {
    const remaining = [
      t.next || '対応コードあり。運用/検証の関連項目は別判定。',
      t.targetMonth
        ? `期限目安: ${t.latestBy}（学校の早い具体日を優先）<br>担当区分: ${cell(t.ownerMode)} / ${cell(t.workMode)}`
        : '',
      t.scope === 'future' ? '将来運用。今回の学校Milestone対象外。' : '',
      t.dependsOn.length ? `前提: ${t.dependsOn.map(taskLink).join('、')}` : '',
      t.issues.map(issueLink).join('、'),
      t.prs.map(prLink).join('、'),
    ]
      .filter(Boolean)
      .join('<br>');
    const evidence = t.evidence.map(evidenceLink).join('<br>') + '<br>' + cell(t.note);
    lines.push(
      `| <a id="${anchor(t.id)}"></a>**${t.id}** ${cell(t.title)} | ${cell(t.phase)} / ${labels[t.status]} | ${cell(t.design)}${t.screens.length ? '<br>' + t.screens.join('・') : ''} | ${evidence} | ${remaining} |`,
    );
  }
  lines.push('');
}
lines.push('## 画面IDの対応（31件）', '', '| 画面 | 実装 | 状態・補足 |', '| --- | --- | --- |');
for (const screen of data.screens)
  lines.push(
    `| ${screen.id} ${screen.title} | ${evidenceLink(screen.file)} | ${labels[screen.status]}。${screen.note} |`,
  );
lines.push(
  '',
  `画面ファイル${pageFileCount}本と設計の31画面IDは同じ数ではない。式場詳細・編集ページをPR66で1本追加。U04は一覧内の確認UI、K02はcouple用画面もあり、補助一覧/ルートも含まれる。`,
  '',
  '## 設計と実装の読み替え',
  '',
  '- 準備シート/打ち合わせ記録はServer Component/Server Actionsで実装。設計表のmeeting-notes/meeting-sheetの専用APIが無いだけで、機能全体を未着手にしない。',
  '- PDFは設計6-11の第一手段である印刷CSS/ブラウザPDF保存を実装。サーバーPDF生成・Storage保存は印刷で足りない場合の追加候補。',
  '- FAQ等の拡張はjob_type/schema/RLSの土台だけがある。専用UI・入力処理・プロンプトが揃った利用可能機能としては扱わない。',
  '- 設計32テーブル中、実装31テーブル。venue_knowledgeは条件付き拡張。mainのmigrationは22本、PR48で索引1本、PR41で別の登録関数1本が追加予定。',
  '- リスクルールの編集画面/LIFF技術検証/サーバーPDF生成は、採用範囲を確認する追加候補。将来の音声文字起こし・クラウドAI・CRM/決済/ネイティブ配布は現行必須タスクへ追加しない。',
  '',
  '## GitHub Issueの状態との違い',
  '',
  '- #19: PR39でE2E実装済み。Issueはopen、意図的退行の負例実施記録は確認待ち。',
  '- #27: PR37でテンプレートはmain反映済み。Issueはopen、作成画面での実表示確認待ち。',
  '- #14: 本文の「未公開/21本」は古い。2026-09-08コメントにプロジェクト・22本・seed・private bucket・5cron・デプロイの実施記録あり。メール/LINE/公開保護/実行成功は別判定。',
  '- #23/#53: 全体進捗と学校の月別成果物を対応付け。347テスト/E2E未着手等の従来計画は当時の記録として保存。元ガントはrepoにないため、ガント本体の更新は未実施。',
  '- #17/#20/#25: 将来運用へ変更し学校Milestoneから除外。#14/#22/#24は発表・検証用の範囲に整理。',
  '- #50/#51: 10月に図/資料を準備。11月の中間発表実施は#58で管理。#53〜65はEpicと12作業Issueを新規登録。登録自体で成果物を完了扱いにしない。',
  '- #26/#28/#29/#33はclosedだが、完了条件の再確認が必要なものはTEAM項目に残す。',
  '- #42/#43/#47はPR46、#44/#45/#49はPR48。openでも実装は済んでおり、未着手にはしない。',
  '',
  '## 更新方法',
  '',
  '1. `docs/implementation-progress.json`の該当IDのstatus/note/next/根拠/Issue/PRを編集する。',
  '2. 実環境作業には日付と記録先、検証にはcommit/CI runを付ける。更新確認日をupdatedAtへ入れる。',
  '3. `node scripts/render-progress.mjs`を実行する。ID・全機能/画面・根拠ファイル・依存・Issue/PR対応を検査し、このMarkdownを再生成する。',
  '4. TASKS/READMEとGitHub Epicを同じ集計へ揃える。Issueを閉じただけで自動的に完了扱いにしない。',
  '',
  '担当区分は学校制作スケジュールと各Issueを参照。月末目安はユーザー指定の月別計画に基づき、具体的な学校日程が早ければそちらを優先する。正式な担当者や実績時間は本人/チームの確認で記録し、推測で埋めない。',
  '',
);
const markdown = lines.join('\n');
if (process.argv.includes('--check')) {
  if (!existsSync(output) || readFileSync(output, 'utf8').replaceAll('\r\n', '\n') !== markdown)
    fail('Markdownが正本と不一致。node scripts/render-progress.mjsで再生成してください。');
} else writeFileSync(output, markdown, 'utf8');
console.log(
  JSON.stringify({
    tasks: data.tasks.length,
    core: core.length,
    screens: data.screens.length,
    counts: Object.fromEntries(Object.keys(labels).map((s, i) => [s, counts(data.tasks)[i]])),
    mode: process.argv.includes('--check') ? 'check' : 'render',
  }),
);
