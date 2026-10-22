# Issue #127：単位1・2の比較

対象は相対期限の共通化、宿題一覧の回答方法・状態タブ、マイページの期限と導線です。
DB・API・マイグレーションと、提出・確認・ナビの実装は変更していません。

PRの追加対応として、CIで再現した既存のESLint設定エラーと、設定復旧後に見つかったReactルール違反も修正しました。画面の比較画像はUI変更時のものを維持し、修正後の検査結果を[validation.md](validation.md)に追記しています。

## 基準と撮影条件

- 最新mainを取得して確認した基準コミット：`905ff30f57b2dcea66f85e9784f919615cc81214`。
- 作業ブランチ：`codex/issue-127-deadline-ui`。
- beforeは既存の作業コピー`bb304ec`から撮影しました。`git diff bb304ec 905ff30 -- src`が空で、アプリのソースが基準mainと同じことを確認しています。撮影スクリプト・過去のE2E・既存画像には差分があり、今回の実装は基準mainから分離したコピーで行っています。
- 2026年10月22日（JST）、同じローカルSupabaseの架空データ`demo-02`を使用。撮影の間に案件・宿題を作り直したり変更したりしていません。
- PC：1440×900、スマホ：390×664（PlaywrightのiPhone 13プリセットのviewport）、deviceScaleFactor 3。スマホ画像は1170×1992pxです。
- ブラウザー：インストール済みMicrosoft Edge（Chromium）。スマホは表示エミュレーションであり、実機Safariの検査ではありません。
- 標準撮影スクリプトと同様、PCは全体、スマホはviewportを撮影。PCの全体撮影だけ固定ナビを隠し、スマホでは表示します。Next.jsの開発バッジは両方で隠しています。

## 比較画像

| 画面                  | before                                                                                 | after                                                                                |
| --------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 08 PCマイページ       | [画像](before/08-couple-mypage.png)                                                    | [画像](after/08-couple-mypage.png)                                                   |
| 09 PC宿題一覧         | [画像](before/09-couple-tasks.png)                                                     | [画像](after/09-couple-tasks.png)                                                    |
| 12 スマホマイページ   | [画像](before/12-mobile-couple-mypage.png)                                             | [画像](after/12-mobile-couple-mypage.png)                                            |
| 12 スマホ最下部・導線 | [画像](before/12-mobile-couple-mypage-bottom.png)                                      | [画像](after/12-mobile-couple-mypage-bottom.png)                                     |
| 13 スマホ宿題一覧     | [画像](before/13-mobile-couple-tasks.png)                                              | [画像](after/13-mobile-couple-tasks.png)                                             |
| 確認済タブ            | [PC](before/09-pc-tasks-confirmed.png)・[スマホ](before/13-mobile-tasks-confirmed.png) | [PC](after/09-pc-tasks-confirmed.png)・[スマホ](after/13-mobile-tasks-confirmed.png) |
| 対応不要タブ（0件）   | [PC](before/09-pc-tasks-waived.png)・[スマホ](before/13-mobile-tasks-waived.png)       | [PC](after/09-pc-tasks-waived.png)・[スマホ](after/13-mobile-tasks-waived.png)       |
| 不備ありタブ          | [PC](before/09-pc-tasks-needs_fix.png)・[スマホ](before/13-mobile-tasks-needs_fix.png) | [PC](after/09-pc-tasks-needs_fix.png)・[スマホ](after/13-mobile-tasks-needs_fix.png) |

対象の4画像（08・09・12・13）は`docs/screenshots/`にも反映します。他画面の画像は更新しません。

## 確認内容

- 相対期限：未来・当日・超過、月末・年末・うるう日、JSTの0時、全状態と回答方法4種を単体テスト。
- 宿題一覧：回答方法4種、状態タブ6件の横はみ出しなし、タブ切替と現在地、確認済の相対期限非表示。対応不要は撮影データでは0件のため、期限抑制は単体テストで確認。
- マイページ：相対期限、最大3件、主ボタン1個、補助リンク2個が1行に収まること。
- 目視：スマホでタブが2行に折り返されること、期限が文言の途中で分断されないこと、主ボタン・補助リンクが下部ナビに隠れないこと。
- 新規E2Eは毎回専用のプランナー・案件・新郎新婦を作り、件数、導線、状態フィルタの再読み込み保持・空表示・未知タブの既定表示も確認します。

## 再撮影

ローカルSupabase・Mailpit、demo-02の登録済みユーザー、`.env.local`が必要です。比較する各ソースでアプリを起動し、`APP_BASE_URL`をそのアプリと同じOriginにします。

```powershell
$env:APP_BASE_URL='http://127.0.0.1:3100' # beforeのアプリ
$env:E2E_MAIL_URL='http://127.0.0.1:54324'
$env:P1_BROWSER_CHANNEL='msedge' # 通常のPlaywright Chromiumを使う場合は未設定
npx tsx scripts/p1-couple-review.mts before
$env:APP_BASE_URL='http://127.0.0.1:3101' # afterのアプリ
npx tsx scripts/p1-couple-review.mts after
```

撮影用OTPでログインし、セッションや認証トークンはファイルに保存しません。`result.json`に撮影時刻と自動確認結果を記録します。afterだけ画面の新しい要件を検証します。

検査結果は[validation.md](validation.md)に記録します。
