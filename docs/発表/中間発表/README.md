# 中間発表資料

Issue [#51](https://github.com/ryuki-moro/Nicomaru/issues/51) の資料です。PowerPointの文字・表・画面遷移図・構成図は編集可能です。PDFは閲覧用の画像PDFで、発表原稿はPowerPointの発表者ノートにも収録しています。

## 最新版と履歴

最新版は [PowerPoint（20261009-r2）](にこまる_中間発表_20261009-r2.pptx)、[閲覧用PDF（20261009-r2）](にこまる_中間発表_20261009-r2.pdf)、[発表原稿](発表原稿.md) です。PR #79の確定CIとmain統合を反映しています。

旧版の [PowerPoint（20261009）](にこまる_中間発表_20261009.pptx)、[PDF（20261009）](にこまる_中間発表_20261009.pdf)、[原稿（20261009）](発表原稿_20261009.md) は、PR #70時点の記録を含む履歴として保持しています。

### r2の検証対象

- CIは [run 37878283145](https://github.com/ryuki-moro/Nicomaru/actions/runs/37878283145)、検証対象は `c6048b2acef8449d4bf99d80ce32880ae98ae46b`、main統合は `214b041d6965bd335d596b5791b261a5671696a2` です。
- 単体・DB834成功/15skip、実PostgreSQL別ジョブ15成功、E2E84成功/負荷用2skip、別のChromium負荷試験1件成功です。主要3モジュール（risk/schedule/session）の分岐網羅率は100%。全コードの網羅率を表す値ではありません。
- CI負荷試験は完走しましたが、**初回画面3秒の目標は未達**です。4 CPU・約16 GBの同一ホストに30ブラウザー・SSR・DBが同居する条件です。[測定原記録](../../検証/performance-37878283145.json)と原稿に数値・条件・限界を記載しました。CPU競合は仮説であり、原因を断定していません。
- コードはmainへ統合済みです。共有Supabaseへの追加6migration適用と、新機能の共有環境での稼働確認は未完了として表示しています。人による評価と発表練習も未実施です。

## 発表条件

- 暫定12枚、約9分。学校の持ち時間・発表日・発表者・質問時間は未共有のため、8〜10分を想定しています。
- 2月は学校の最終発表・デモです。本番運用開始は予定していません。
- 画面画像は既存の模擬データによる撮影です。氏名は撮影スクリプト・試験データと照合済みです。実在顧客の事例や新規実測結果として扱いません。
- 自動試験の成功件数とCI負荷試験の測定値は特定のPR/commitに対する記録です。CIの模擬データで測った応答性能と、人間による使い勝手、実端末、作業時間の評価を区別します。人による評価は未実施・未測定です。

## 編集する人向け

PowerPointで文字や表を直接修正できます。図の箱と接続線も編集できます。Agent AIの契約は不要です。発表前に、最新画面、実装の版、実際に行った試験の記録と数値を照合してください。確認していない項目は未実施のまま残します。

`presentation-status.json` は、検証件数・対象commit・現在の統合状態の入力です。`build-presentation.mjs` は本文・発表原稿を含む再生成ソースです。`docs/implementation-progress.json` の全体CI欄と個別PRの検証記録は対象版が違う場合があります。混ぜて記載しないでください。

| 入力                                                        | 対応する記録                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `referencePr` / `verifiedCommit` / `ciRunUrl`               | 検証したPR・commit・そのCI実行URL                                                   |
| `unitPassed` / `unitSkipped` / `postgresPassed`             | 単体・DBジョブの成功とskip、実PostgreSQLの別ジョブの成功。合算してskipを隠さない    |
| `browserPassed` / `browserSkipped` / `browserScope`         | 同じCI実行のE2E成功・skip件数とブラウザー/模擬端末の範囲                            |
| `auditVulnerabilities` / `secretFindings`                   | 依存監査の全重大度の脆弱性件数と秘密情報検出件数                                    |
| `branchCoveragePercent` / `branchCoverageScope`             | 分岐網羅率と対象範囲。主要モジュールの値を全コードの網羅率としない                  |
| `mainCommit` / `mainStatus`                                 | mainに統合したcommitと状態。検証対象commitとは分ける                                |
| `loadTest.state` / `conditionLabel` / `summary` / `metrics` | 負荷条件、目標の達否、単位付きの実測値。`measured_target_unmet`は計測済み・目標未達 |
| `loadTest.ciOutcome` / `passedTests`                        | 負荷試験自体の実行結果。画面表示の性能目標達成と区別する                            |
| `deploymentStatus`                                          | 共有環境へのDB変更適用と稼働確認の状態                                              |
| `humanEvaluationStatus`                                     | 実端末、使い勝手、人の作業時間の評価状態                                            |

未確定の件数は `null` にします。0件成功や0件の脆弱性と置き換えません。負荷試験の結果・詳細な測定値、commit、CI URLは発表原稿と全スライドの発表者ノートにも入ります。スライド9・10の説明はこれらの入力から作成します。

## 再生成する人向け

同梱の `@oai/artifact-tool` を使用します。依存パッケージの追加インストール、実DB操作、外部メールやAIへの通信は行いません。ビルド途中のPPTX、各ページの画像、検証報告はGit管理外の `.env.venue-preview/presentation-build/` に保存します。

1. `presentation-status.json` と本文を、確認した証拠に基づいて更新します。
2. Presentationsスキルに従い、作成/編集開始のマーカーを1回実行します。r2改訂時はPPTX/PDFとも実行済みです。
3. 同梱Node.jsで下書きを作成します。ランタイムが別の場所の場合は `ARTIFACT_RUNTIME`、スキルが別の場所の場合は `PRESENTATIONS_SKILL_DIR` を設定します。

```powershell
& "$env:USERPROFILE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe" `
  "docs/発表/中間発表/build-presentation.mjs" --draft-only --revision=20261009-r3
```

4. 全12枚のPNGを1枚ずつ確認し、文字切れ・図の方向・根拠・見やすさを修正します。
5. 同じrevisionで `--draft-only` を外すと、finalizerの検証後にPPTXとPDFを出力します。既存の最終PPTXは上書きできないため、再改訂では新しいrevision名を使用します。
6. 最終PPTXから出力した `final-01.png`〜`final-12.png` を再確認します。

同梱版のPDF exporterには標準フォントモジュールの不足があるため、`slides-to-pdf.py` が最終PPTXの高解像度画像からPDFを作ります。PDF内の文字編集・検索には対応しません。PPTXの最終検証後にPDF出力だけをやり直す場合は、同じrevisionで `--render-final` を指定できます。検証報告のSHA-256と最終PPTXの一致を確認してから再出力します。

## 発表前に人が行う確認

- 学校の持ち時間に合わせて通し練習し、実測した時間を記録する。
- 発表者・デモ担当者・質問への回答担当を決める。
- 実際の端末でPPTXを開き、フォント・画面比率・接続線を確認する。
- デモ用アカウントや通信が使えない場合は、保存済み画面で操作の流れを説明する。
- 学校の提出先への提出と、発表当日の実施結果・作業時間をWBSへ記入する。

今回の自動検証は、PPTXの構造・編集可能な表・文字配置と画像レンダリングの確認です。PowerPointアプリ本体での投影試験は未実施です。
