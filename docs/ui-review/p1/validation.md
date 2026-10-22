# 検査記録（2026年10月22日）

基準main：`905ff30`。アプリのUI変更は単位1・2です。追加対応で既存のESLint設定と、復旧後に検出されたReactルール違反を修正しました。

## 依存監査の追加修正

Vitest・coverage-v8を4.1.12、推移依存のViteを8.3.5へ更新し、high 1件・moderate 3件を解消しました。`npm audit --json`は全severityで0件です。詳細と再検査結果は[dependency-audit.md](dependency-audit.md)に記録しています。以下のESLint修正時の監査失敗は過去の記録です。

## ESLint修正時の検査（`6f44684`）

| 検査                     | 結果                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `npm run lint`           | 成功、エラー0・警告0                                                                     |
| `npm run test`           | 成功、856件成功・15件skip・失敗0（計871）。43ファイル成功・2skip                         |
| ESLint設定の回帰テスト   | 6件成功。従来の5件に加えて、Core Web Vitalsの同期script禁止がerrorとして有効なことを検証 |
| `npm run typecheck`      | 成功                                                                                     |
| `npm run progress:check` | 成功                                                                                     |

15件のskipは`TEST_PG_URL`未設定の実PostgreSQL用2ファイルです。ローカルのPGliteテストは通過し、元のCIの`concurrency-db`でも実PostgreSQLの検査が成功しています。

`npm run format:check`も成功しました。追加で`accessibility.spec.ts`・`otp-service-unavailable.spec.ts`・`core-flow.spec.ts`をPC／スマホ幅で実行し、12件すべて成功しました。無効なログインリンクのエラー表示・OTP案内・URLからのエラー除去も新規に検証しています。

### 修正内容

- Next 16のflat configを旧形式用の`FlatCompat`へ渡す処理をやめ、baseとTypeScriptの設定を直接読み込みます。固定されたNext 14プラグインのCore Web Vitals設定は旧形式のため、baseで登録済みのプラグインに対してrulesだけを重ねます。旧ルールAPI用の`fixupConfigRules`は維持しています。
- Service Role Keyの参照制限、Next.jsルールの警告・エラーを維持しています。ルールの無効化・重要度引下げ・依存パッケージの変更はありません。
- 設定復旧後に見つかった3件のReactルール違反は、ログインリンク着地時の状態同期をtransitionにまとめ、招待状況の状態更新をPromiseのコールバックに明示し、容量集計の期限判定へサーバーで取得した時刻を渡すことで修正しました。API・DBと画面の文言・配置は変えていません。
- 標準撮影スクリプトの未使用型importも削除しました。

### 元のCIで確認した結果

[CI run 39701434342](https://github.com/ryuki-moro/Nicomaru/actions/runs/39701434342)は初回UIコミット`5f36fc5`に対する実行です。`verify`はLintで同じ循環JSONエラーとなり、後続の型・テスト・buildはskipでした。`concurrency-db`は成功しました。

`security`は別原因で失敗しています。依存監査にVite 8.3.2のhigh 1件とVitest関連のmoderate 3件があり、Secret scanはskipされています。これは今回のESLint設定修正では解消しておらず、PR全体のCI成功とは区別します。依存更新は今回行っていません。

元のCIの`e2e`は85件成功・2件skip・1件失敗でした。失敗は新規表示テストのmobileで、空の確認済タブから対応不要タブへ切り替える途中に次の`page.goto`が走り、遷移が競合したものです。対応不要タブのURLと`aria-current`が確定するのを待つようにテストを修正し、ローカルPC／スマホ幅の2件とも成功しました。アプリのフィルタ動作とテストの検証条件は変更していません。元のCIの300案件・30同時ユーザーの負荷検査は成功しています。

## 初回UI変更時の記録（`5f36fc5`）

| 検査                                 | 結果                                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 追加の相対期限・回答方法の単体テスト | 11件成功                                                                                                                                                                                                    |
| typecheck                            | 成功                                                                                                                                                                                                        |
| lint                                 | 失敗。`eslint.config.mjs`読み込み時の`TypeError: Converting circular structure to JSON`。変更前の作業コピーでも同じエラーを再現。変更ファイルの解析前に止まる既存の設定不整合で、今回設定は変更していません |
| 画面比較スクリプト                   | before/after各11画像を撮影。afterはPC/SP各3組の自動確認を完了                                                                                                                                               |
| 新規表示E2E                          | PC/SPの両方で成功（2実行）                                                                                                                                                                                  |
| 既存core-flow・permissions           | 初回は17成功・1失敗。失敗したPCの「案件登録から確認まで」は単独再実行で成功                                                                                                                                 |
| 差分の空白検査                       | `git diff --check`成功                                                                                                                                                                                      |

全体の`npm run test`は850件成功・15件skip・5件失敗（計870）。ファイル単位は42成功・2skip・1失敗でした。失敗5件はすべて既存の`tests/unit/eslint-config.test.ts`で、lintと同じ設定読み込みエラーです。Windowsの一時ファイルrename権限でsandbox実行が失敗したため、権限付きで再実行した結果を記載しています。

最終の`npm run format:check`、`npm run progress:check`、`npm run typecheck`は成功しました。

## E2Eの実行条件と初回失敗

既存の`core-flow.spec.ts`、`permissions.spec.ts`と新規`couple-display.spec.ts`を、インストール済みMicrosoft EdgeのPC・スマホ幅で実行しました。合計20実行のうち初回19成功・1失敗、失敗1件は再実行で成功です。skipはありません。

初回の失敗箇所は、今回変更していない初回登録画面です。`tests/e2e/helpers/flows.ts`の`registerPrimaryPartner`がマイページへの遷移を20秒待ってタイムアウトしました。失敗画像では入力値と同意チェックが消えていました。SSR表示直後の入力とReactの初期化が競合した可能性がありますが、原因は断定していません。アプリや既存helperを書き換えず、準備済み画面で同じケースを再実行すると13.2秒で成功しました。初回結果を全件成功へ読み替えません。

スマホ表示の撮影とE2EはChromiumのエミュレーションです。実機Safariは未実施です。Playwright標準ブラウザーのダウンロードがタイムアウトしたため、既存Edgeを使用しました。

ローカル専用設定では`playwright.config.ts`を読み、webServerを起動済みのafterアプリに向け、ブラウザーを次の2構成に差し替えました。標準設定と依存ファイルは変更していません。

```ts
projects: [
  { name: 'edge-pc', use: { ...devices['Desktop Chrome'], channel: 'msedge' } },
  {
    name: 'edge-mobile',
    use: { ...devices['iPhone 13'], browserName: 'chromium', channel: 'msedge' },
  },
];
```

接続先はアプリ`http://127.0.0.1:3101`、Supabase `http://127.0.0.1:54321`、Mailpit `http://127.0.0.1:54324`。E2Eは専用の架空ユーザー・案件を新規作成し、撮影用demo-02は変更していません。

## 目視結果

- 宿題一覧：全6タブをスマホ幅で表示。回答方法を4種類表示し、既存の期限間近の色を維持。
- 相対期限：「あと3日」などを途中で分断せず、必要に応じてひとまとまりで次行に表示。
- 確認済：相対期限を出さず、絶対期限と状態を維持。対応不要の非空行は単体テストで期限非表示を確認（撮影fixtureは0件）。
- マイページ：「次にやること」の期限・件数・順番を維持し、主ボタンと1行の補助リンクを表示。最下部でも固定ナビに隠れないことを画像で確認。

撮影条件と比較画像は[README.md](README.md)、自動確認の実行時刻は[after/result.json](after/result.json)を参照してください。
