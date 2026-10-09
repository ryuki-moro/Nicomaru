import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// このファイルとpresentation-status.jsonを更新するとPPTX/PDF/原稿を再生成できる。
// 秘密情報、実DB、外部メール/AIサービスは使用しない。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const BUILD = path.join(ROOT, '.env.venue-preview/presentation-build');
const runtimeRoot =
  process.env.ARTIFACT_RUNTIME ??
  path.join(
    process.env.USERPROFILE ?? '',
    '.cache/codex-runtimes/codex-primary-runtime/dependencies',
  );
const MODULES = path.join(runtimeRoot, 'node/node_modules');
process.env.RUNTIME_NODE_MODULES = MODULES;
const PYTHON = path.join(runtimeRoot, 'python/python.exe');
const SKILL =
  process.env.PRESENTATIONS_SKILL_DIR ??
  path.join(
    process.env.USERPROFILE ?? '',
    '.codex/plugins/cache/openai-primary-runtime/presentations/26.1007.11041/skills/presentations',
  );
await fs.mkdir(BUILD, { recursive: true });
try {
  await fs.symlink(MODULES, path.join(BUILD, 'node_modules'), 'junction');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const requireRuntime = createRequire(path.join(BUILD, 'loader.mjs'));
const { Presentation, PresentationFile, FileBlob } = await import(
  pathToFileURL(requireRuntime.resolve('@oai/artifact-tool')).href
);
const { GlobalFonts } = requireRuntime('@napi-rs/canvas');
for (const file of ['YuGothM.ttc', 'YuGothB.ttc']) {
  GlobalFonts.registerFromPath(path.join(process.env.WINDIR ?? 'C:/Windows', 'Fonts', file));
}
const FONT = 'Yu Gothic';
if (!GlobalFonts.families.some((entry) => entry.family === FONT))
  throw new Error('Yu Gothicを利用できません。日本語フォントを確認してください。');
const { finalizePresentation } = await import(
  pathToFileURL(path.join(SKILL, 'container_tools/artifact_tool_utils.mjs')).href
);
const status = JSON.parse(await fs.readFile(path.join(HERE, 'presentation-status.json'), 'utf8'));
const progress = JSON.parse(
  await fs.readFile(path.join(ROOT, 'docs/implementation-progress.json'), 'utf8'),
);
const revision =
  process.argv.find((value) => value.startsWith('--revision='))?.slice(11) ??
  status.asOf.replaceAll('-', '');
if (!/^[a-zA-Z0-9_-]+$/.test(revision))
  throw new Error('revisionには英数字・ハイフンを指定してください');
const output = path.join(HERE, `にこまる_中間発表_${revision}.pptx`);
const pdfPath = path.join(HERE, `にこまる_中間発表_${revision}.pdf`);
const draft = path.join(BUILD, `draft-${revision}.pptx`);
const previewDir = path.join(BUILD, revision);
await fs.mkdir(previewDir, { recursive: true });

const p = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const C = {
  ink: '#203948',
  muted: '#60747F',
  pink: '#C54F76',
  cream: '#F8F5EF',
  pale: '#F1E5E9',
  line: '#BBC6CB',
  white: '#FFFFFF',
};
const slides = [];
const text = (s, value, x, y, w, h, size = 30, options = {}) => {
  const box = s.shapes.add({
    geometry: 'textbox',
    position: { left: x, top: y, width: w, height: h },
    fill: 'none',
    line: { fill: 'none', width: 0 },
  });
  box.text = value;
  box.text.style = {
    typeface: FONT,
    fontSize: size,
    color: C.ink,
    insets: 0,
    autoFit: 'none',
    wrap: 'square',
    verticalAlignment: 'top',
    ...options,
  };
  return box;
};
function slide(title, seconds, speech, sources, dark = false) {
  const s = p.slides.add();
  s.background.fill = dark ? C.ink : C.cream;
  text(s, title, 64, 45, 1150, 74, 44, { bold: true, color: dark ? C.white : C.ink });
  text(s, String(p.slides.items.length), 1160, 670, 56, 24, 18, {
    alignment: 'right',
    color: dark ? '#CBD5DC' : C.muted,
  });
  s.speakerNotes.text = `${speech}\n\n出典: ${sources.join('、')}\n状態基準日: ${status.asOf}`;
  slides.push({ title, seconds, speech, sources });
  return s;
}
function table(s, values, widths, top = 174, height = 410, size = 28) {
  const t = s.tables.add({
    rows: values.length,
    columns: values[0].length,
    left: 64,
    top,
    width: 1152,
    height,
    columnWidths: widths,
    values,
  });
  t.borders.assign({ fill: C.line, width: 1, style: 'solid' });
  t.cells
    .block({ row: 0, column: 0, rowCount: values.length, columnCount: values[0].length })
    .assign({
      textStyle: { typeface: FONT, fontSize: size, color: C.ink },
      margins: { left: 18, right: 14, top: 15, bottom: 12 },
      anchor: 'center',
      fill: C.white,
    });
  t.cells.block({ row: 0, column: 0, rowCount: 1, columnCount: values[0].length }).assign({
    fill: C.ink,
    textStyle: { typeface: FONT, fontSize: size, color: C.white, bold: true },
  });
  return t;
}
function node(s, label, x, y, w = 255, h = 90) {
  const a = s.shapes.add({
    geometry: 'rect',
    position: { left: x, top: y, width: w, height: h },
    fill: C.white,
    line: { fill: C.ink, width: 2 },
  });
  a.text = label;
  a.text.style = {
    typeface: FONT,
    fontSize: 27,
    color: C.ink,
    bold: true,
    alignment: 'center',
    verticalAlignment: 'middle',
    insets: 10,
  };
  return a;
}
const connect = (s, a, b, opts = {}) =>
  s.shapes.connect(a, b, {
    kind: 'straight',
    fromSide: 'right',
    toSide: 'left',
    line: { fill: C.pink, width: 3 },
    tail: { type: 'arrow', width: 'med', length: 'med' },
    ...opts,
  });
async function screenshot(s, name, x, y, w, h) {
  const bytes = await fs.readFile(path.join(ROOT, 'docs/screenshots', name));
  s.images.add({
    blob: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    contentType: 'image/png',
    alt: `模擬データを表示した既存画面 ${name}`,
    fit: 'contain',
    position: { left: x, top: y, width: w, height: h },
  });
}

{
  const s = slide(
    'にこまる',
    25,
    '結婚式準備の進行管理アプリ「にこまる」の中間発表です。新郎新婦の提出物と、プランナーによる確認を同じ場所で扱います。本日は、解決したい課題、実装した流れ、検証の状況と今後の学校発表までの進め方を説明します。',
    ['docs/にこまる_要件定義書_完成版.docx', 'docs/学校制作スケジュール.md'],
    true,
  );
  text(s, '結婚式準備の\n提出・確認を支える', 64, 235, 1100, 178, 64, {
    bold: true,
    color: C.white,
  });
  text(s, `中間発表　${status.asOf} 時点`, 68, 545, 1000, 44, 28, { color: '#DCE4E8' });
}
{
  const s = slide(
    '準備状況を共有するための課題',
    45,
    '要件で扱う課題は、期限と提出内容が分散し、何が未提出なのか、確認待ちなのかを把握しにくいことです。そこで、案件ごとの宿題、提出物、確認結果をまとめます。新郎新婦には次に行う作業を示し、プランナーには確認やフォローが必要な案件を示します。作業時間が短くなるかどうかは、これから校内の模擬評価で確かめます。',
    ['docs/にこまる_要件定義書_完成版.docx', 'docs/BridalHub_基本設計書.docx'],
  );
  text(s, '準備で困ること', 64, 175, 490, 52, 32, { color: C.pink, bold: true });
  text(
    s,
    '期限が複数の連絡に分散する\n提出後の確認状況が分かりにくい\n担当者が変わると経緯を追いにくい',
    64,
    258,
    560,
    225,
    30,
  );
  text(s, 'アプリで扱うこと', 680, 175, 520, 52, 32, { color: C.pink, bold: true });
  text(
    s,
    '案件ごとの宿題と期限\n提出・差し戻し・確認済みの状態\n連絡履歴と打ち合わせ準備',
    680,
    258,
    530,
    225,
    30,
  );
  text(s, '効果は校内の模擬評価で確認する予定です', 64, 588, 1145, 50, 26, { color: C.muted });
}
{
  const s = slide(
    '4つの利用者と参照範囲',
    45,
    '利用者は4種類です。新郎新婦は自分の案件だけ、プランナーは担当案件を扱います。式場管理者は同じ式場の利用者や設定を管理し、システム管理者は式場の登録とシステム全体の状況を確認します。画面の出し分けだけではなく、データベースのRLSでも範囲を制限します。役割を変えたり別案件のIDを指定したりしても、許可されていないデータを操作できないことを試験します。',
    [
      'src/lib/constants.ts',
      'supabase/migrations/20260828000500_rls_policies.sql',
      'tests/db/rls.test.ts',
    ],
  );
  table(
    s,
    [
      ['利用者', '主な操作', '参照する範囲'],
      ['新郎新婦', '宿題の確認・提出', '本人の案件'],
      ['プランナー', '提出確認・フォロー', '担当案件'],
      ['式場管理者', '利用者・テンプレート管理', '自分の式場'],
      ['システム管理者', '式場登録・利用状況の確認', '全体の管理情報'],
    ],
    [280, 470, 402],
    168,
    432,
    28,
  );
  text(s, '権限は画面とデータベースの両方で検証します', 64, 627, 1140, 36, 25, { color: C.muted });
}
{
  const s = slide(
    '提出から確認までの画面の流れ',
    55,
    '中心となる流れです。プランナーが案件を作り、宿題と期限を用意します。新郎新婦はマイページで宿題を確認し、本文やファイルを提出します。プランナーは提出物確認画面で確認済みにするか、不備の理由を付けて差し戻します。差し戻された場合は再提出します。この一連の状態変更を、提出者と確認者の両方の視点で確認します。',
    [
      'src/app/(staff)/cases',
      'src/app/(couple)/mypage',
      'src/app/(staff)/submissions',
      'tests/e2e/core-flow.spec.ts',
    ],
  );
  const a = node(s, '案件・宿題を用意', 65, 205);
  const b = node(s, 'マイページで提出', 510, 205);
  const c = node(s, 'プランナーが確認', 955, 205);
  connect(s, a, b);
  connect(s, b, c);
  const d = node(s, '不備あり・再提出', 510, 428);
  const e = node(s, '確認済み', 955, 428);
  connect(s, c, e, { fromSide: 'bottom', toSide: 'top' });
  connect(s, c, d, { fromSide: 'bottom', toSide: 'right', kind: 'elbow' });
  connect(s, d, b, { fromSide: 'top', toSide: 'bottom' });
  text(s, '担当者', 68, 160, 255, 36, 24, { color: C.muted });
  text(s, '新郎新婦', 510, 160, 255, 36, 24, { color: C.muted });
  text(s, '担当者', 955, 160, 255, 36, 24, { color: C.muted });
  text(s, '状態の更新と提出履歴を同じ案件にひも付けます', 65, 600, 1110, 44, 28, {
    color: C.muted,
  });
}
{
  const s = slide(
    '新郎新婦のマイページ',
    45,
    'こちらは保存済みの画面例です。氏名や案件は撮影用の模擬データです。挙式までの日数と、次に行う宿題を表示し、宿題一覧や準備タイムラインへ進めます。発表では、未提出の宿題を開いて入力し、提出後に状態が変わるところを見せます。スクリーンショットは既存版のため、今回の変更を含む最新画面との照合は発表前に行います。',
    [
      'docs/screenshots/12-mobile-couple-mypage.png',
      'scripts/screenshot-tour.mts',
      'tests/e2e/core-flow.spec.ts',
    ],
  );
  await screenshot(s, '12-mobile-couple-mypage.png', 64, 145, 430, 505);
  text(s, '次に行う宿題を確認', 585, 195, 610, 64, 34, { bold: true });
  text(
    s,
    '期限を見て宿題を開く\n内容を入力して提出する\n提出後の状態を確認する',
    585,
    298,
    600,
    180,
    31,
  );
  text(s, '模擬データによる既存画面例', 585, 588, 605, 42, 25, { color: C.muted });
}
{
  const s = slide(
    'プランナーの提出物確認',
    45,
    'プランナーは、案件ごとに届いた提出物を確認します。確認済み、または不備ありを選び、必要ならコメントを返します。画面例には、AI補助を利用できない状態でもコメントを手入力できる案内があります。AIを停止した状態でも、提出と確認という中心の作業は続けられます。誤った案件を操作できないことと、二重操作や再提出の状態も確認対象にしています。',
    [
      'docs/screenshots/06-submission-review.png',
      'src/app/(staff)/submissions',
      'tests/db/rls-submission.test.ts',
    ],
  );
  await screenshot(s, '06-submission-review.png', 64, 162, 780, 472);
  text(s, '確認済み\nまたは不備あり', 890, 204, 330, 110, 32, { bold: true });
  text(s, '理由をコメント\n再提出を確認', 890, 365, 330, 125, 30);
  text(s, 'AI停止時も手入力可能', 890, 544, 326, 80, 27, { color: C.pink, bold: true });
}
{
  const s = slide(
    'システム構成とデータの境界',
    65,
    'WebアプリはNext.jsで作り、ブラウザーから操作します。認証、データベース、ファイル保管はSupabaseを使います。通常の利用者の操作は本人のセッションとRLSで制限します。定期処理は内部シークレットで入口を分けます。AIを使う場合は、ローカルのワーカーがジョブを取り出し、Ollamaで生成します。校内のサーバーを外部公開しない構成を採り、個人情報を外部のAI APIへ送らない方針です。学校の最終発表でデモする予定で、現時点で本番運用の予定はありません。',
    ['docs/BridalHub_基本設計書.docx 2章・6章・7章', 'src/lib/supabase', 'worker/ai-worker.ts'],
  );
  const browser = node(s, 'ブラウザー', 64, 225, 230, 100);
  const app = node(s, 'Next.js\n画面・API', 485, 225, 260, 100);
  const db = node(s, 'Supabase\nAuth / DB / Storage', 895, 225, 320, 100);
  connect(s, browser, app);
  connect(s, app, db);
  const worker = node(s, 'ローカルAIワーカー\nOllama', 485, 465, 350, 112);
  connect(s, worker, db, { fromSide: 'right', toSide: 'bottom', kind: 'elbow' });
  text(s, '本人のセッション', 314, 175, 230, 40, 24, { color: C.muted });
  text(s, 'RLSで範囲を制限', 764, 175, 270, 40, 24, { color: C.muted });
  text(s, 'AIジョブを取得し\n結果を書き戻す', 880, 444, 330, 98, 25, { color: C.muted });
  text(s, '学校デモが対象。本番運用は現時点で予定していません', 64, 628, 1120, 44, 25, {
    color: C.muted,
  });
}
{
  const s = slide(
    'AI補助と手動操作の分担',
    50,
    'アプリのAI補助は、自由記述の分類や文章の下書きなどを支援します。生成結果をそのまま確定せず、担当者が確認して利用します。AIが使えない場合は手動の確認と入力で作業を続けます。開発用のCodexと、アプリに組み込むローカルAIは別のものです。他のメンバーがAgent AIを契約しなくても、動作確認、資料編集、発表練習やWBSの記録を担当できます。',
    ['docs/BridalHub_基本設計書.docx 7章', 'docs/学校制作スケジュール.md', 'src/components/ai'],
  );
  table(
    s,
    [
      ['作業', 'AI補助', '利用できない場合'],
      ['提出内容の確認', '分類・不備候補', '担当者が内容を読む'],
      ['返信文の作成', '文章の下書き', 'コメントを手入力'],
      ['最終判断', '担当者が結果を確認', '同じ確認手順を続ける'],
    ],
    [270, 395, 487],
    174,
    352,
    29,
  );
  text(s, '開発用Agent AIの契約は、チーム参加の条件にしません', 64, 584, 1120, 64, 29, {
    color: C.pink,
    bold: true,
  });
}
{
  const s = slide(
    '実装と検証の記録',
    55,
    `記録済みの検証結果です。${status.verificationLabel}では単体やDB関連の試験${status.unitPassed}件、Chromeによるブラウザー操作${status.browserPassed}件が成功し、当時の依存監査の脆弱性は${status.auditVulnerabilities}件でした。これは特定の版に対する結果です。今回追加した容量監視、監査、PWAなどは別途統合検証を進めています。未実施の実端末試験や使い勝手評価を、これらの自動テストの成功に含めません。mainへの反映状況は進捗台帳とPRで確認します。`,
    [
      'docs/implementation-progress.json',
      `https://github.com/ryuki-moro/Nicomaru/pull/${status.referencePr}`,
      'presentation-status.json',
    ],
  );
  text(s, status.verificationLabel, 64, 160, 1150, 44, 28, { color: C.muted });
  text(s, String(status.unitPassed), 64, 242, 400, 118, 92, { color: C.pink, bold: true });
  text(s, '単体・DB関連の成功件数', 64, 378, 500, 65, 28);
  text(s, String(status.browserPassed), 685, 242, 400, 118, 92, { color: C.pink, bold: true });
  text(s, 'Chromeブラウザー操作の成功件数', 685, 378, 525, 90, 28);
  text(s, status.currentIntegrationStatus, 64, 523, 1145, 48, 30, { bold: true });
  text(s, '実端末・性能・使い勝手は別途確認します', 64, 590, 1145, 44, 27, { color: C.muted });
}
{
  const s = slide(
    '評価方法と未測定の項目',
    55,
    '評価は、自動試験と人による確認を分けます。権限や業務状態は、正常な操作だけでなく、別案件へのアクセス、期限の境界、DBやStorageの失敗を再現して確かめます。一方で、実端末で迷わず操作できるか、どのくらい時間が掛かるかはまだ評価していません。校内で同じシナリオを試し、所要時間と詰まった箇所を記録します。模擬評価の結果を、実際の式場での導入効果として発表しないよう区別します。',
    ['tests/db', 'tests/unit', 'tests/e2e', 'docs/学校制作スケジュール.md'],
  );
  table(
    s,
    [
      ['観点', '確認する方法', '現状'],
      ['権限・業務状態', 'RLS・API・画面の自動試験', '版ごとに記録'],
      ['障害時の動作', 'DB・Storageの失敗を再現', '自動試験を追加'],
      ['実端末・操作性', '同じ課題を人が操作する', '未実施'],
      ['性能・作業時間', '所要時間と遅い処理を測る', '未測定'],
    ],
    [300, 540, 312],
    169,
    434,
    28,
  );
  text(s, '校内の模擬評価と、実際の式場での導入効果を区別します', 64, 628, 1140, 40, 25, {
    color: C.muted,
  });
}
{
  const s = slide(
    '2月の学校発表までの予定',
    45,
    '学校の予定に合わせ、10月は実装と発表資料、11月は追加実装、テスト技法、中間発表とAWSの課題に取り組みます。12月はテスト仕様書と試験の証拠を揃え、1月は最終コードと発表資料を固めます。2月は学校の最終発表とデモを行い、作業実績を記入したWBSで振り返ります。前倒しはできますが、学校が示す提出日より後にはしません。具体的な日程と担当者はチームで確定します。',
    ['docs/学校制作スケジュール.md', 'https://github.com/ryuki-moro/Nicomaru/issues/53'],
  );
  table(
    s,
    [
      ['月', '主な作業', '揃える成果物'],
      ['10月', '製造・資料作成', 'コード・詳細設計図・発表資料'],
      ['11月', '製造・テスト技法・中間発表・AWS', 'コード・演習/発表の記録'],
      ['12月', '仕様書作成・テスト', 'テスト仕様書・エビデンス'],
      ['1月', 'テスト・最終発表の準備', '最終コード・資料・エビデンス'],
      ['2月', '学校の最終発表・デモ・まとめ', '発表記録・実績付きWBS'],
    ],
    [138, 495, 519],
    162,
    454,
    26,
  );
  text(s, '前倒し可。具体的な学校の提出日があれば、その期限を優先します', 64, 635, 1145, 40, 24, {
    color: C.muted,
  });
}
{
  const s = slide(
    '質疑応答',
    20,
    '今後は、追加機能を含む同じ版でデモを再現し、メンバーによる操作確認と発表練習を行います。人が測った結果と作業実績を残し、2月の学校発表につなげます。以上で説明を終わります。ご質問をお願いします。',
    ['docs/学校制作スケジュール.md', 'https://github.com/ryuki-moro/Nicomaru'],
    true,
  );
  text(s, '次の確認は\n同じ版でのデモ再現と\nメンバーによる操作評価', 64, 211, 1135, 224, 52, {
    bold: true,
    color: C.white,
  });
  text(s, 'にこまる　結婚式準備進行管理アプリ', 64, 575, 1140, 45, 28, { color: '#DCE4E8' });
}

await (await PresentationFile.exportPptx(p)).save(draft);
for (let i = 0; i < p.slides.items.length; i += 1) {
  const png = await p.export({ slide: p.slides.items[i], format: 'png', scale: 1 });
  await fs.writeFile(
    path.join(previewDir, `slide-${String(i + 1).padStart(2, '0')}.png`),
    new Uint8Array(await png.arrayBuffer()),
  );
}
await fs.writeFile(path.join(BUILD, `deck-${revision}.json`), JSON.stringify(p.toProto()));
await fs.writeFile(
  path.join(BUILD, `source-status-${revision}.json`),
  JSON.stringify(
    { status, progressUpdatedAt: progress.updatedAt, mainCommit: progress.mainCommit },
    null,
    2,
  ),
);
const notes = [
  '# にこまる 中間発表 原稿',
  '',
  `作成基準日: ${status.asOf}。想定発表時間は約${Math.round(slides.reduce((sum, item) => sum + item.seconds, 0) / 60)}分（8〜10分の暫定構成）。実際の持ち時間・発表者は未確定。`,
  '',
  ...slides.flatMap((item, i) => [
    `## ${i + 1}. ${item.title}（目安${item.seconds}秒）`,
    '',
    item.speech,
    '',
    `根拠: ${item.sources.join(' / ')}`,
    '',
  ]),
  '## 想定質問への回答',
  '',
  '- AIが停止したら？ 提出・確認・コメント入力を手動で継続します。AI生成の品質や稼働確認は別途記録します。',
  '- 他の式場の情報は見える？ 本人のセッションとRLSで参照範囲を制限し、別式場・別案件の拒否試験を行います。',
  '- 効果はどのくらい？ 人による性能・使い勝手の測定は未実施です。現時点で削減率や満足度は示していません。',
  '- 本番運用はいつ？ 現時点で予定はありません。2月は学校の最終発表・デモです。',
  '- Agent AIを契約していないメンバーは？ 動作確認、Officeでの資料編集、発表練習、WBSの実績記入を担当できます。',
  '',
  '## 発表前に更新する箇所',
  '',
  '- presentation-status.jsonの検証対象commit・実測件数・統合状態を、その版の証拠と照合する。',
  '- 最新画面と既存スクリーンショットの差を確認し、必要なら模擬データで撮影し直す。',
  '- 学校が示す持ち時間、発表日、発表者、質問時間を確定し、通し練習で時間を測る。',
  '- 人間による試験の未実施欄を、実際に記録した結果だけで更新する。',
];
await fs.writeFile(path.join(HERE, '発表原稿.md'), notes.join('\n') + '\n', 'utf8');

if (process.argv.includes('--draft-only')) {
  console.log(
    JSON.stringify({
      draft,
      previewDir,
      slides: slides.length,
      status: 'draft-ready-for-visual-review',
    }),
  );
} else {
  const result = process.argv.includes('--render-final')
    ? {
        finalPath: output,
        receiptPath: path.join(BUILD, `validation-${revision}.json`),
      }
    : await finalizePresentation({
        workspaceDir: ROOT,
        candidatePath: draft,
        finalPath: output,
        pythonExecutable: PYTHON,
        integrityValidatorPath: path.join(
          SKILL,
          'container_tools/inspect_presentation_package_integrity.py',
        ),
        layoutValidatorPath: path.join(
          SKILL,
          'container_tools/inspect_presentation_layout_geometry.py',
        ),
        layoutArgs: [
          '--expected-slide-size-emu',
          '12192000,6858000',
          '--validate-bullet-geometry',
          '--validate-heading-fit',
          ...[3, 8, 10, 11].flatMap((number) => ['--require-native-table-slide', String(number)]),
        ],
        explicitTotalSlideCount: 12,
        requiredNativeTableOwnerSlides: [3, 8, 10, 11],
        requiredNativeChartOwnerSlides: [],
        fontPolicy: { basis: 'design', families: [FONT] },
        verifyArtifactToolImport: true,
        receiptPath: path.join(BUILD, `validation-${revision}.json`),
      });
  // 最終PPTXの検証済みバイト列を確認してから再読込する。
  const receipt = JSON.parse(await fs.readFile(result.receiptPath, 'utf8'));
  if (
    createHash('sha256')
      .update(await fs.readFile(result.finalPath))
      .digest('hex') !== receipt.finalSha256
  ) {
    throw new Error('最終PPTXが検証時のファイルと一致しません');
  }
  const finalDeck = await PresentationFile.importPptx(await FileBlob.load(result.finalPath));
  for (let i = 0; i < finalDeck.slides.items.length; i += 1) {
    const png = await finalDeck.export({
      slide: finalDeck.slides.items[i],
      format: 'png',
      scale: 2,
    });
    await fs.writeFile(
      path.join(previewDir, `final-${String(i + 1).padStart(2, '0')}.png`),
      new Uint8Array(await png.arrayBuffer()),
    );
  }
  // この同梱版のPDF exporterにはstandard-fontsの不足があるため、検証済みPPTXの
  // 高解像度レンダリングから閲覧用PDFを作る。編集にはPPTXを使う。
  const pdfResult = spawnSync(PYTHON, [path.join(HERE, 'slides-to-pdf.py'), previewDir, pdfPath], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (pdfResult.status !== 0) throw new Error(`PDF作成に失敗しました: ${pdfResult.stderr}`);
  console.log(
    JSON.stringify({
      output,
      pdfPath,
      previewDir,
      slides: slides.length,
      receipt: result.receiptPath,
    }),
  );
}
