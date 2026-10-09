# 中間発表資料

Issue [#51](https://github.com/ryuki-moro/Nicomaru/issues/51) の資料です。PowerPointの文字・表・画面遷移図・構成図は編集可能です。PDFは閲覧用の画像PDFで、発表原稿はPowerPointの発表者ノートにも収録しています。

## 発表条件

- 暫定12枚、約9分。学校の持ち時間・発表日・発表者・質問時間は未共有のため、8〜10分を想定しています。
- 2月は学校の最終発表・デモです。本番運用開始は予定していません。
- 画面画像は既存の模擬データによる撮影です。氏名は撮影スクリプト・試験データと照合済みです。実在顧客の事例や新規実測結果として扱いません。
- 自動試験の成功件数は特定のPR/commitに対する記録です。人間による使い勝手、実端末、性能の評価は未実施・未測定として区別しています。

## 編集する人向け

PowerPointで文字や表を直接修正できます。図の箱と接続線も編集できます。Agent AIの契約は不要です。発表前に、最新画面、実装の版、実際に行った試験の記録と数値を照合してください。確認していない項目は未実施のまま残します。

`presentation-status.json` は、検証件数・対象commit・現在の統合状態の入力です。`build-presentation.mjs` は本文・発表原稿を含む再生成ソースです。`docs/implementation-progress.json` の全体CI欄と個別PRの検証記録は対象版が違う場合があります。混ぜて記載しないでください。

## 再生成する人向け

同梱の `@oai/artifact-tool` を使用します。依存パッケージの追加インストール、実DB操作、外部メールやAIへの通信は行いません。ビルド途中のPPTX、各ページの画像、検証報告はGit管理外の `.env.venue-preview/presentation-build/` に保存します。

1. `presentation-status.json` と本文を、確認した証拠に基づいて更新します。
2. Presentationsスキルに従い、作成/編集開始のマーカーを1回実行します。今回の作成時は実行済みです。
3. 同梱Node.jsで下書きを作成します。ランタイムが別の場所の場合は `ARTIFACT_RUNTIME`、スキルが別の場所の場合は `PRESENTATIONS_SKILL_DIR` を設定します。

```powershell
& "$env:USERPROFILE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe" `
  "docs/発表/中間発表/build-presentation.mjs" --draft-only --revision=20261009-r2
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
