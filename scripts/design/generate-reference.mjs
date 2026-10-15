import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';

const root = process.cwd();
const target = join(root, 'docs/詳細設計');
const schema = JSON.parse(readFileSync(join(target, 'schema.json'), 'utf8'));
const progress = JSON.parse(readFileSync('docs/implementation-progress.json', 'utf8'));
const features = progress.tasks.filter((task) => task.id.startsWith('F-'));
if (features.length !== 49 || progress.screens.length !== 31)
  throw new Error('機能49件・画面31件の対応を再確認してください');
const cell = (value) =>
  String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
const link = (file) => '[' + file + '](../../' + file + ')';
const table = (headers, rows) =>
  [headers, headers.map(() => '---'), ...rows]
    .map((row) => '| ' + row.map(cell).join(' | ') + ' |')
    .join('\n');
const formatting = (await resolveConfig(join(target, 'README.md'))) ?? {};
const writes = [];
const save = (name, content) =>
  writes.push(
    format(content + '\n', { ...formatting, parser: 'markdown' }).then((formatted) =>
      writeFileSync(join(target, name), formatted, 'utf8'),
    ),
  );

save(
  '機能画面対応.md',
  [
    '# 機能49件・画面31件の実装対応',
    '',
    '参照元: 基本設計3-2、docs/implementation-progress.json、現在の作業ブランチ。main反映の判定は実装進捗一覧を参照する。',
    '',
    '## 機能',
    '',
    table(
      ['機能ID', '機能', '対象', '画面ID', '実装の入口'],
      features.map((task) => [
        task.id.slice(2),
        task.title,
        task.scope === 'conditional' ? '条件付き拡張（学校成果物の対象外）' : 'コア',
        task.screens.join(', ') || '共通/バックエンド',
        task.evidence.map(link).join('<br>'),
      ]),
    ),
    '',
    '## 画面',
    '',
    'S02は登録と編集の設計上の同一画面ID。登録用 /venues/new、編集用 /venues/[venueId] の両経路を持つ。U04は独立URLではなく一覧の確認操作。',
    '',
    table(
      ['画面ID', '画面名', '対応機能ID', '実装'],
      progress.screens.map((screen) => [
        screen.id,
        screen.title,
        features
          .filter((task) => task.screens.includes(screen.id))
          .map((task) => task.id.slice(2))
          .join(', ') || '共通画面（認証/エラー/補助）',
        link(screen.file),
      ]),
    ),
  ].join('\n'),
);

const api = [];
const actions = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(file);
      continue;
    }
    if (!/\.tsx?$/.test(file)) continue;
    const relative = file.replaceAll('\\', '/').replace(root.replaceAll('\\', '/') + '/', '');
    const text = readFileSync(file, 'utf8');
    if (entry.name === 'route.ts') {
      const methods = [
        ...text.matchAll(
          /export\s+(?:const|async\s+function)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
        ),
      ].map((match) => match[1]);
      const rpc = [...text.matchAll(/\.rpc\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
      const schemas = [...text.matchAll(/parseBody\(\s*[^,]+,\s*(\w+)\s*\)/g)].map(
        (match) => match[1],
      );
      const guards = [
        ...text.matchAll(/\b(requireRole|requireStaff|requireAppUser)\(([^)]*)\)/g),
      ].map((match) => match[1] + '(' + match[2].replace(/\s+/g, ' ') + ')');
      const path = '/' + relative.slice('src/app/'.length).replace('/route.ts', '');
      const special = path.startsWith('/api/internal/')
        ? 'internal-cron: shared secret'
        : path === '/api/line/webhook'
          ? 'raw body HMAC signature'
          : path === '/api/health'
            ? '公開・生存可否のみ'
            : guards.join('; ') || '認証専用API: 個別検証をコード参照';
      api.push([
        methods.join(', '),
        path,
        special,
        schemas.join(', ') || 'URL/FormData/専用検証',
        rpc.join(', ') || 'サービス/直接RLSクエリ',
        link(relative),
      ]);
    }
    if (text.includes("'use server'") || text.includes('"use server"')) {
      actions.push([
        link(relative),
        [...text.matchAll(/async\s+function\s+(\w+)\(/g)].map((match) => match[1]).join(', '),
      ]);
    }
  }
}
visit(join(root, 'src/app'));
save(
  'APIと更新境界.md',
  [
    '# API・Server Actions・トランザクション境界',
    '',
    '一覧はソースの静的参照を抽出したもの。複数HTTPメソッドを持つファイルは行単位でまとめ、条件分岐ごとの許可ロールはリンク先を正本とする。動的RPC名・下位サービスの呼出先はこの表に重複列挙しない。',
    '',
    '## 共通契約',
    '',
    '- ブラウザ更新API: 同一Originを本文解析より先に確認する。認証後もRLSで式場/案件の可視性を制限する。',
    '- 内部定期API: Originの代わりに共有secretを検証する。Service Role用途は src/lib/supabase/admin.ts の明示許可表に限定。',
    '- LINE webhook: 生の本文に対する署名を検証し、イベントIDをDBで重複排除する。',
    '- 正常: JSONまたは204。異常: { error: { code, message, details: [{ field, reason }] } }。401は未認証、403は停止/権限/Origin拒否、404は対象不可視/不存在、409は競合、429は制限、503は一時的な接続失敗。',
    '- Server Componentsは読み取りをRLSクライアントで直接実施。Server Actionsも認証/役割を確認し、ユーザー権限のRPC/RLSを使用する。',
    '',
    table(['メソッド', 'API', '認証入口', '入力スキーマ参照', '直接RPC参照', '実装'], api),
    '',
    '## Server Actions',
    '',
    table(['実装ファイル', 'async関数（action以外の補助も含む）'], actions),
    '',
    '## 一貫性・補償',
    '',
    table(
      ['操作', '確定単位', '失敗時', '根拠'],
      [
        [
          '案件登録',
          'create_wedding_case RPC内: 採番/案件/2プロフィール/2招待/履歴',
          'RPC内は全体ロールバック。宿題割当は後続の別RPC。招待外部送信も別処理',
          link('src/app/api/cases/route.ts'),
        ],
        [
          '招待消費/初回登録',
          'consume_invitation が原子的UPDATE',
          'Auth作成失敗はrestore_invitationで消費を戻す補償。作成途中のAuthを清掃',
          link('src/app/api/auth/initial-register/route.ts'),
        ],
        [
          '宿題割当',
          'assign_case_tasks RPC単位',
          '不正な宿題があればRPCをロールバック',
          link('src/app/api/cases/[caseId]/assign-tasks/route.ts'),
        ],
        [
          '提出',
          'submit_task_atomic RPC + 最新提出ポインタ',
          '同時提出をロックで直列化。ファイル保存は別境界',
          link('src/app/api/tasks/[taskId]/submit/route.ts'),
        ],
        [
          '確認/差戻し',
          'review_submission RPC',
          '最新でない提出の競合は409。自動承認はしない',
          link('src/app/api/submissions/[submissionId]/review/route.ts'),
        ],
        [
          'LINE枠',
          'claim_line_quota RPCの予約',
          '複数呼出で枠超過しない。枠外/未紐付けはメールへ',
          link('src/lib/services/notifications.ts'),
        ],
        [
          '削除/匿名化',
          'Storage外部操作→成功分metadata→DB処理（完了マーカーなし）',
          '外部/DB失敗を成功件数に含めず再実行対象を保持。200件ずつキーで走査、成功済みも冪等に再処理。batch_runsへ失敗を記録',
          link('src/app/api/internal/case-purge/route.ts'),
        ],
        [
          '日次容量/監視',
          '集計RPC・UPSERTのスナップショット/アラート',
          '失敗HTTPを返しbatch_runsへ記録。外部へ個人情報を送信しない',
          link('src/app/api/internal/usage-rollup/route.ts'),
        ],
      ],
    ),
  ].join('\n'),
);

save(
  'データ辞書と権限.md',
  [
    '# データ辞書と権限境界',
    '',
    '最新migrationを隔離PGliteへ適用したcatalogを採取。実利用者データ・秘密値を含まない。publicテーブルは現在' +
      schema.tables.length +
      '件、列' +
      schema.columns.length +
      '件、RLS policy ' +
      schema.policies.length +
      '件。Issue50起票時の31件にusage_snapshots/system_alertsが追加された。venue_knowledgeは未実装の条件付き候補。',
    '',
    '## ロール',
    '',
    table(
      ['ロール', '境界', '許可/制限の要点'],
      [
        [
          'couple',
          'couple_profiles.user_profile_id → 自案件',
          '自案件/自宿題のみ。risk/memo/他案件/管理操作は不可',
        ],
        [
          'planner',
          'venue_id + primary_planner_id',
          '担当案件の進行/招待/確認/フォロー。自分のrole/venue_idを昇格不可',
        ],
        ['admin', '所属venue_id', '式場内の管理。system_admin作成は不可'],
        [
          'system_admin',
          '全式場の管理用途',
          '式場/利用状況/通知CSV/監視。経路で明示的にrequireRole',
        ],
        [
          'service_role',
          '許可用途 + API/cron/signature認証',
          'RLSを迂回できるためブラウザ/一般CRUD/AI workerには渡さない',
        ],
        [
          'ai_worker',
          '専用DBロールの限定RPC',
          'ジョブ取得/結果/心拍のみ。一般テーブルへの無制限アクセスなし',
        ],
      ],
    ),
    '',
    'current_app_user()はactiveのみ。停止・削除・初回設定前はRLSで拒否する。memo列等は列権限と専用RPCを併用し、RLSの行制限だけでは保護できない部分を補う。',
    '',
    ...schema.tables.flatMap((tableInfo) => [
      '## ' + tableInfo.name,
      '',
      'RLS: ' + (tableInfo.rls ? '有効' : '無効'),
      '',
      table(
        ['列', '型', 'NULL', '既定値'],
        schema.columns
          .filter((column) => column.table_name === tableInfo.name)
          .map((column) => [
            column.column_name,
            column.data_type,
            column.is_nullable,
            column.column_default || '—',
          ]),
      ),
      '',
      ...schema.constraints
        .filter(
          (constraint) =>
            constraint.table_name === tableInfo.name &&
            ['p', 'f', 'u', 'c'].includes(constraint.type),
        )
        .map(
          (constraint) =>
            '- ' + constraint.type.toUpperCase() + ': `' + constraint.definition + '`',
        ),
      '',
      table(
        ['policy', '操作', '対象role'],
        schema.policies
          .filter((policy) => policy.table_name === tableInfo.name)
          .map((policy) => [policy.policyname, policy.cmd, policy.roles]),
      ),
      '',
    ]),
    '## RPC一覧',
    '',
    'security_definer=trueは呼出し元より強い権限で動作する。引数の所属/状態検証、検索パス固定、EXECUTE権限とセットでレビューする。ポリシーの完全なqual/with_checkはschema.jsonに保存。',
    '',
    table(
      ['関数', '引数', '結果', 'security_definer'],
      schema.functions.map((fn) => [fn.name, fn.arguments, fn.result, fn.security_definer]),
    ),
  ].join('\n'),
);

for (const feature of features.filter((entry) => entry.scope !== 'conditional')) {
  for (const file of feature.evidence)
    if (!existsSync(file)) throw new Error('実装参照がありません: ' + file);
}
for (const screen of progress.screens)
  if (!existsSync(screen.file)) throw new Error('画面参照がありません: ' + screen.file);
await Promise.all(writes);
console.log(
  JSON.stringify({
    features: features.length,
    screens: progress.screens.length,
    apiFiles: api.length,
    actionFiles: actions.length,
    tables: schema.tables.length,
  }),
);
