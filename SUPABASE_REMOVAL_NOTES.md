# Supabase 削除作業の記録

## 状態: 未完了・指示の矛盾について回答待ち

2026-11-06 に `SUPABASE_REMOVAL_TASK.md` を読み、D1 分岐の整理、旧依存・マイグレーション削除、テスト移行の作業を開始した。ただし、以下の条件が両立しないことを型チェックで確認した。

- 絶対ルール: 「残存ファイル自体は変更しない」「ただしその場合も import が壊れない範囲に留める」。
- 手順8: 「src/lib/supabase/ フォルダごと削除」。
- 手順11: SDK依存 `@supabase/ssr` / `@supabase/supabase-js` を削除。
- 残存候補は当該クライアントを直接 import する。特に `src/app/api/auth/dev-admin/route.ts` は `@supabase/supabase-js` を直接 import している。これらを未変更で残して依存を削除すると、型チェックおよびビルドが成立しない。
- 手順6は残存候補に必要なサービス実装を残すよう指定する一方、参照検索の許容範囲は残存候補のファイル群のみとなっている。残存候補が使う `src/lib/services/cases.ts` の `setCaseArchived` もこの条件に関係する。

残存候補をD1へ移植してよいか、必要な互換実装を別ファイルに残すか、作業中に質問した。回答がまだないため、変更禁止の解除や依存を残す例外を独断で適用していない。

## 最終的な作業ツリー

途中のソース・依存・設定・テストへの変更はすべて元に戻した。削除済みのファイルも復元した。`docs/` は変更していない。削除・書き換えの完了を報告できるファイルはない。この記録だけを追加し、ユーザー提供の `SUPABASE_REMOVAL_TASK.md` を維持した。コミットはしていない。

作業途中の差分は `/tmp/supabase-removal-wip.patch` に退避した。これは未完成であり、そのまま適用する成果物ではない。

## 実行した検証

以下は**変更途中の試行**に対する結果であり、最終ツリーの合格結果ではない。テストを削除・スキップして成功扱いにはしていない。未完了の削除が検証を通ったという意味にはならない。

| 検証                                                | 実行結果                                                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase参照検索                                    | `rg -n -i supabase src worker scripts tests .github package.json .env.example` を実行。333行。残存候補を除いても0行になっていない。残存候補内は下表参照。         |
| `npm run typecheck`                                 | 失敗。残存候補のクライアント参照、削除したSDK・サービスを参照するテスト等でエラー。passed/skipped件数を出すコマンドではない。                                     |
| `npm test`                                          | 56ファイル中32 passed / 24 failed。テスト670 passed / 112 failed、合計782。skippedの表示なし（0）。モジュール解決段階の失敗は実行されたテスト件数には含まれない。 |
| `npm run test:d1`                                   | 11ファイルのサブテストで0 passed / 11 failed / 0 skipped。個別ケースが完走した件数ではない。ログではファイル単位の `test failed` のみで詳細原因は確定できない。   |
| `npm run test:demo`                                 | 3ファイルのサブテストで2 passed / 1 failed / 0 skipped。失敗は `tests/demo/server.test.mjs`。個別ケースが完走した件数ではない。                                   |
| `npm run cf:build`                                  | 実行開始。Next.js の optimized production build 段階で、復元と並行した結果を合格扱いしないため中断。成功は確認していない。                                        |
| `npm install --ignore-scripts --no-audit --no-fund` | 削除試行時に実行、11 packages removed。復元後にも元のlockに合わせて再実行。prepareによるGit設定変更は行わない。                                                   |

検証ログは `/tmp/removal-typecheck.log`, `/tmp/removal-test.log`, `/tmp/removal-d1.log`, `/tmp/removal-demo.log`, `/tmp/removal-cf-build.log`, `/tmp/removal-reference-scan.log` に退避している。

## 指定された残存候補と検索行数

下記は途中の参照検索時の一致行数。これらのファイルは変更していない。最終ツリーでは他の実装も復元されており、下表だけが参照の全件ではない。

| ファイル                                          | 一致行数 | 理由                         |
| ------------------------------------------------- | -------: | ---------------------------- |
| `src/app/(couple)/mypage/account/page.tsx`        |        3 | D1未置換として変更禁止に指定 |
| `src/app/(staff)/cases/[caseId]/archive/page.tsx` |        5 | D1未置換として変更禁止に指定 |
| `src/app/(staff)/cases/[caseId]/follow/page.tsx`  |        6 | D1未置換として変更禁止に指定 |
| `src/app/(staff)/dashboard/page.tsx`              |        7 | D1未置換として変更禁止に指定 |
| `src/app/(staff)/notifications/page.tsx`          |        3 | D1未置換として変更禁止に指定 |
| `src/app/api/auth/complete-invite/route.ts`       |        4 | D1未置換として変更禁止に指定 |
| `src/app/api/auth/dev-admin/route.ts`             |        6 | D1未置換として変更禁止に指定 |
| `src/app/api/auth/shared.ts`                      |        5 | D1未置換として変更禁止に指定 |
| `src/app/api/cases/[caseId]/archive/route.ts`     |        3 | D1未置換として変更禁止に指定 |
| `src/app/api/cases/[caseId]/follow-logs/route.ts` |        8 | D1未置換として変更禁止に指定 |
| `src/app/api/dashboard/follow-up-today/route.ts`  |        4 | D1未置換として変更禁止に指定 |
| `src/lib/auth/login-link.ts`                      |        3 | D1未置換として変更禁止に指定 |

残存候補内の合計: 57行 / 12ファイル。その他: 276行。

## 再開に必要な判断

変更禁止の残存候補も必要な範囲でD1へ移植する許可、またはクライアント・SDK・必要なサービスを残す例外のどちらかが必要。前者では残存機能のD1実装と移行テストを追加する。後者では完全削除と参照0件の達成範囲を明示的に変更する必要がある。

## 第2ラウンド（2026-11-06）: WIPを保持して完全削除を実装

上記は第1ラウンド時点の過去記録。このラウンドは適用済みWIPから継続し、変更を復元していない。「回答待ち」「最終ツリーで復元済み」は現在の状態を示さない。第2ラウンド指示の確定判断に従って実装・検証を進めた。コミット・リモート配備・リモートDB更新は行っていない。

### 実装と判断

- `src/lib/supabase/` を全削除。SDK import・環境変数・旧分岐を切り離し、`usingD1/publicD1` は常にtrue。AIワーカーは共有トークン付きAPI接続のみ。
- アカウント画面はD1で解決したAppUserの氏名・メールを表示。終了済みLINE連携の案内を出さない。middlewareと下部ナビでアカウント画面を開けるようにした。
- アーカイブは `src/lib/d1/cases.ts` の `setCaseArchived` を追加し、既存 `patchCase` の現在ロール・所属・version検査を共有。画面のServer Action/APIを接続し、管理者だけが日時設定・解除できる。
- `cloudflare/migrations/0022_follow.sql` にfollow_logs/communication_logsと索引・外部キー・値域制約を追加。`src/lib/d1/follow.ts` は閲覧・登録時にD1の有効状態・担当/所属・アーカイブ状態を検査し、実行者を入力本文から受け取らない。フォロー一覧のページングを維持。
- 宿題提出・確認/差戻し時は連絡履歴をD1へ記録。補助履歴の失敗では業務処理を戻さず、固定メッセージだけを記録する。リスクの最終活動には提出・フォロー・連絡履歴を使用。180日後の案件削除処理に新しい2テーブルも追加。
- ダッシュボードとfollow-up-today APIは共通D1集計で担当件数・未提出・リスク件数/根拠を表示。スタッフ通知履歴はD1の案件範囲と送信ログを使う。middlewareの許可経路とスタッフナビを更新し、移植した画面への導線を戻した。
- complete-inviteは稼働コードの呼出側がゼロ。登録画面は `/api/auth/initial-register` を使うため旧routeと不要スキーマを削除。shared.tsはguest-formが使うappBaseUrlだけ残した。
- dev-admin route/script/npm script/ボタン/設定ライブラリを削除。D1 fixturesとdemo-loginで代替。demo-loginが必要な同一Origin・loopback検査だけ `src/lib/auth/local-demo.ts` に移した。
- **マジックリンク廃止・OTP一本化**。login-linkライブラリ、/login/link画面、fragment処理を削除。otp-requestは既にD1のsendVerificationOTPを使っており、リンク生成は残っていない。職員のパスワード認証・パスワード再設定は維持。
- `tests/d1/*.browser.mjs` と `tests/demo/browser-smoke.mjs` が `@playwright/test` を直接importしていることを確認したため依存を維持。未使用の旧tests/e2e、playwright.config.ts、test:e2e scriptは削除。
- 旧PG前提のprepare-observability-migration、demo/targets、design/export-schema、Mailpit/旧ログイン前提のscreenshotsとp1-couple-reviewを削除。check-environmentはAPP_BASE_URL/Better Auth/暗号化鍵を調べるD1構成へ変更。設計図生成スクリプトの現行構成表記を更新（docsの生成物は変更していない）。
- package.jsonの旧直接依存は除去済み。`npm install --ignore-scripts --no-audit --no-fund` でlockを更新（11 packages removed）。prepareによるGit設定変更を避けた。`pg` はBetter Authからの間接依存としてlockに残る（`npm ls pg`で確認）。アプリからのPG接続と直接依存はない。旧SDK、@types/pg、PGliteは依存ツリーにない。
- CIのconcurrency-dbは削除済み。keepaliveは指定のWorkers `/api/health`。README/TASKS/.env.exampleを現行D1手順へ更新。
- ユニット検証で見つかったバッチ終了記録の例外漏えいを修正。開始失敗と同様、DB例外本文を外へ返さず固定文言にする。既存D1モック検査で確認。

### テストの整理（件数の扱い）

旧SDK/RPCのモックを使うテストは、下記理由で削除した。D1側検証は同じ全アサーションを一対一で移植したものではなく、削除前のテスト件数との同等性を主張しない。最終の実行件数だけを次節へ記載する。

- `tests/unit/monitoring.test.ts`: 旧RPC監視サービス廃止。D1版は tests/d1/admin-ops.test.mjs で検証。
- `tests/unit/login-link.test.ts`: マジックリンク廃止・OTP一本化。
- `tests/unit/invitation-recipient.test.ts`: 旧RLS宛先サービス廃止。D1 onboarding/delivery で検証。
- `tests/unit/dev-admin-route.test.ts`: 開発管理者API廃止。ローカルD1 fixtures/demo-loginで代替。
- `tests/unit/demo-targets.test.ts`: PostgreSQLデモ接続先検査廃止。デモはローカルD1のみ。
- `tests/unit/auth-rate-limit-route.test.ts`: 旧SDK/RPC専用テスト廃止。D1 onboardingでレート制限を検証。
- `tests/unit/auth-rate-limit-fetch.test.ts`: 旧SDK通信アダプタ廃止。
- `tests/unit/auth-email-config.test.ts`: 削除したconfig.tomlとメールテンプレートの契約検査廃止。D1 OTPはonboardingで検証。
- `tests/unit/case-purge.test.ts`: 旧SDK HTTP fixture廃止。D1 admin-opsで保持期限と削除を検証。
- `tests/unit/risk-store-login.test.ts`: 旧riskStore廃止。D1 core-featuresでリスク入力を検証。
- `tests/unit/performance-cleanup.test.ts`: 削除した旧E2EのPostgreSQL後始末ヘルパー専用検査廃止。
- `tests/unit/password-auth.test.ts`: 旧SDK認証モック廃止。D1 onboardingとbrowserで認証を検証。
- `tests/unit/notification-send-route.test.ts`: 旧SDK通知モック廃止。D1 deliveryで宛先と通知を検証。
- `tests/unit/notification-log-export.test.ts`: 旧SDK HTTP fixture廃止。D1 deliveryでログ出力を検証。
- `tests/unit/notification-dispatch.test.ts`: 旧SDK配信サービス廃止。D1 delivery/admin-opsで配信を検証。
- `tests/unit/venue-update.test.ts`: 旧SDK HTTP fixture廃止。D1 admin-opsで式場権限と更新を検証。
- `tests/unit/demo-seed-command.test.ts`: 削除したPG seed CLI専用テスト廃止。tests/demoでD1デモを検証。
- `tests/unit/invitation-landing.test.ts`: 旧SDK招待モック廃止。D1 onboardingで期限・無効化・登録を検証。
- `tests/unit/invitation-api-combination.test.ts`: 旧SDK招待APIモック廃止。D1 onboardingで役割別招待を検証。
- `tests/unit/audit-retention-route.test.ts`: 旧管理SDKモック廃止。D1 core-featuresで保持期限を検証。
- `tests/unit/api-origin.test.ts`: 旧SDK認証モック廃止。D1のAPI境界はtests/d1で検証。
- `tests/unit/dev-admin-launcher.test.ts`: 削除したdev-adminランチャー専用の拒否検査。D1ローカル起動で代替。
- `tests/unit/dev-admin.test.ts`: dev-admin専用設定・旧ランチャーの対象消滅。デモの境界検査はD1 demo-loginテストで維持。

書き換えたユニットテスト: session/health-route/internal-batch/middleware/notification-page/demo-login-routeはD1のモック・挙動へ変更。eslint-configは削除済みキーの境界検査だけ除去し、Nextルール互換検査を維持。back-navigationは現在のD1着地点に一致させた。

追加したD1テストは `tests/d1/core-features.test.mjs` の4ケース（フォローの範囲とページ境界、アーカイブ/解除の所属とロール、ダッシュボード/通知履歴の範囲、連絡履歴の実行者固定）。既存D1テストの明示migrationリストへ0022を追加した。

第1ラウンドWIPで削除済みのDBテスト/ヘルパーも、最終削除一覧として列挙する。旧PostgreSQL/RLS/PGlite専用であり、D1へ統一したため維持しない。

- `tests/db/ai-jobs.test.ts`
- `tests/db/audit.test.ts`
- `tests/db/case-task-state.test.ts`
- `tests/db/concurrency.test.ts`
- `tests/db/demo-seed-pg.test.ts`
- `tests/db/demo-seed.test.ts`
- `tests/db/guest-rsvp.test.ts`
- `tests/db/guest-tags.test.ts`
- `tests/db/harness.ts`
- `tests/db/invitation-recipient-rls.test.ts`
- `tests/db/last-login.test.ts`
- `tests/db/monitoring.test.ts`
- `tests/db/notifications.test.ts`
- `tests/db/pg-harness.ts`
- `tests/db/risk.test.ts`
- `tests/db/rls-submission.test.ts`
- `tests/db/rls.test.ts`
- `tests/db/smoke.test.ts`
- `tests/db/venue-permissions.test.ts`

旧Playwright E2E/ヘルパーの全削除一覧（CIの実行先はtests/d1のため）:

- `tests/e2e/README.md`
- `tests/e2e/accessibility.spec.ts`
- `tests/e2e/ai-availability.spec.ts`
- `tests/e2e/ai-workflow.spec.ts`
- `tests/e2e/api-origin.spec.ts`
- `tests/e2e/core-flow.spec.ts`
- `tests/e2e/couple-display.spec.ts`
- `tests/e2e/dev-admin-login.spec.ts`
- `tests/e2e/helpers/admin.ts`
- `tests/e2e/helpers/ai-worker.ts`
- `tests/e2e/helpers/env.ts`
- `tests/e2e/helpers/first-screen-mark.ts`
- `tests/e2e/helpers/flows.ts`
- `tests/e2e/helpers/mail.ts`
- `tests/e2e/helpers/performance-cleanup.ts`
- `tests/e2e/login-link-ui.spec.ts`
- `tests/e2e/login-link.spec.ts`
- `tests/e2e/login-return-ui.spec.ts`
- `tests/e2e/login-return.spec.ts`
- `tests/e2e/notification-link-ui.spec.ts`
- `tests/e2e/notification-log-export.spec.ts`
- `tests/e2e/otp-service-unavailable.spec.ts`
- `tests/e2e/performance-load.spec.ts`
- `tests/e2e/permissions.spec.ts`
- `tests/e2e/pwa-performance.spec.ts`
- `tests/e2e/venue-edit.spec.ts`

### 最終検証

実行環境はNode v24.22.1。ローカル待受（TCPとtsxのIPC）に `EPERM` が発生する。Wranglerのホーム配下ログ書込みもEROFSだったため、`XDG_CONFIG_HOME=/tmp/nicomaru-removal-config` でログ出力先を変更して再実行した。待受制限は残る。テストをskipに変更したり、失敗を成功として扱ったりしていない。

| 検証                                                                           | 最終結果（実数）                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grep -ri supabase src worker scripts tests .github package.json .env.example` | **0行**。rgでも0行。package-lock.jsonも別途0行。旧src/lib/supabase、supabase、tests/e2eの各ディレクトリは不存在。                                                                                                                                      |
| `npm run db:d1:setup`                                                          | **失敗（exit 1）**。通常出力先のEROFSを解消して再実行したが `listen EPERM 127.0.0.1`。Wrangler経由のmigration適用成功とは扱わない。                                                                                                                    |
| `npm run typecheck`                                                            | **成功（exit 0）**。古い削除済みルートの生成型を含む.nextを再生成し、残存importも解消。                                                                                                                                                                |
| `npm test`                                                                     | **33ファイル成功 / 0失敗。504テスト成功 / 0失敗 / 0 skipped**。削除した旧テストを分母に含めない。                                                                                                                                                      |
| `npm run test:d1`                                                              | **11ファイルの実行単位: 0成功 / 11失敗 / 0 skipped（exit 1）**。個別ケースが実行成功した件数ではない。core-featuresをisolationなしで診断すると10ケースすべてbefore hookの `listen EPERM 127.0.0.1` で失敗。                                            |
| `npm run test:demo`                                                            | **3ファイルの実行単位: 2成功 / 1失敗 / 0 skipped（exit 1）**。server.test.mjs失敗。isolationなしの診断では配信テスト6件すべて `listen EPERM 127.0.0.1`。                                                                                               |
| `npm run cf:build`                                                             | **成功（exit 0）**。Nextコンパイル・型検査・36ページ生成・OpenNext bundle完了。`.open-next/worker.js` を生成。配備はしていない。                                                                                                                       |
| `npm run lint`（追加）                                                         | **成功（exit 0）、0 errors / 60 warnings**。警告は旧分岐撤去後の未使用宣言等。抑制設定を追加していない。                                                                                                                                               |
| `git diff --check`（追加）                                                     | 成功。                                                                                                                                                                                                                                                 |
| 全migrationのSQLite構文/整合性検証（追加）                                     | **19ファイル適用成功**（0022を含む）。`PRAGMA integrity_check` は `ok`。Wrangler/D1実行とは別の補助検証。                                                                                                                                              |
| SQLiteアダプタによる業務ロジック検証（追加）                                   | core-features/tasks/cases/admin-opsの**4ファイル成功 / 0失敗 / 0 skipped**。個別実行でもcore-features **10成功**、tasks **7成功**を確認。ソースのSQLとfixturesをそのまま使用し、D1接続だけ一時SQLiteアダプタへ差替えた。D1そのものの合格とは扱わない。 |

補助SQLite検証の初回では、一時アダプタにD1のmeta.changesとbatchの直列性が不足しtasksが失敗した。アダプタ側を修正して上表の最終結果を確認した。アプリや正式テストの期待値を緩めていない。補助アダプタ/コピーは `/tmp` のみで、通常の `test:d1` の実装・実行先は変更していない。

最終ログ: `/tmp/removal2-typecheck-final.log`, `/tmp/removal2-unit-final.log`, `/tmp/removal2-d1-final.log`, `/tmp/removal2-demo-final.log`, `/tmp/removal2-cf-build-final.log`, `/tmp/removal2-lint-final.log`, `/tmp/removal2-setup-retry.log`, `/tmp/removal2-d1-final-diagnostic.log`, `/tmp/removal2-demo-diagnostic.log`, `/tmp/removal2-sqlite-final-confirm.log`, `/tmp/removal2-tasks-sqlite-final2.log`, `/tmp/removal2-migrations.log`, `/tmp/removal2-grep-final.log`。

### 残存と検証上の限界

指定検索範囲の残存は **0ファイル / 0行**。D1未置換を理由に残した候補ファイルはない。docsと過去の設計・migration内の歴史的コメントは検索対象外で、過去資料まで書き換えていない。旧テスト削除の内訳は上記一覧のとおり。

実行環境の待受制限により、Wrangler経由のローカルD1適用・D1正式テスト・デモHTTP配信は未合格。追加SQLと業務ロジックの補助検証は成功したが、正式D1検証の代わりにはしない。待受が許可された環境で指定3コマンドを再実行する必要がある。コミットなし。WIPを保持した実装と検証記録を作業ツリーに残した。
