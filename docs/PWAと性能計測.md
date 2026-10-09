# PWAと性能計測

対象: GAP-02、GAP-05、QA-06、QA-08。基本設計2-2・8-1・8-4・10・11章の実装補足。

## PWAの採用方針

ホーム画面追加用のmanifest、192/512pxアイコン、maskableアイコン、Apple用180pxアイコンを用意する。アイコンの編集元は `public/icons/icon.svg`。起動先とscopeは同一サイトの `/`、表示方式は `standalone` とする。

基本設計のSerwist指定は、今回の実装では依存追加のないネイティブService Workerへ変更する。完全オフライン対応は対象外であり、オフライン保存、Push通知、バックグラウンド同期の要件がないため。Next.js公式はネイティブSWの配置方法と、オフライン機能を追加する場合のSerwistを案内している。ホーム画面追加の必要条件を満たすためにキャッシュ機能を導入する必要はない。

- [Next.js公式 PWAガイド](https://nextjs.org/docs/app/guides/progressive-web-apps)
- [MDN インストール可能なPWAの要件](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- [MDN アイコンとmaskable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Define_app_icons)

`public/sw.js` はinstall/activateのみ扱い、fetchを横取りしない。CacheStorage、オフライン代替ページ、自動再送を使わない。認証Cookie、HTML/RSC、API、提出物、署名付きURLをService Workerへ保存しない。APIには `private, no-store, max-age=0` を付け、動的画面は既存Next.jsの動的描画方針を維持する。SW自身はno-storeとし、更新時にHTTPキャッシュを利用しない。Service Workerの登録に失敗しても通常のWeb操作を継続できる。

ブラウザが管理する通常のセッションCookieや、ユーザーが明示的に保存したファイルを消す仕組みではない。ログアウト時の認証破棄は既存のログアウト処理が担当する。

Chrome等はメニューの「アプリをインストール」、iPhone/iPadのSafariは共有メニューの「ホーム画面に追加」を使う。公開先ではHTTPSが必要。ローカルの `127.0.0.1` は開発用に許可される。実端末のメニュー・表示・通知可否はブラウザ依存であり、自動検査と分けてQA-07で記録する。

## 性能ログの契約

APIは共通 `route()` に入った時点から処理終了までを測る。Origin拒否、内部secret拒否、業務エラーも含む。既存の認証/認可を省略しない。

| フィールド             | 内容                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| event                  | `api_performance`                                                    |
| route                  | 固定テンプレート名。例 `/api/cases/[caseId]`、未登録経路は `unknown` |
| method                 | 標準のHTTPメソッドまたは `OTHER`                                     |
| startedAt / finishedAt | サーバー時刻（UTC ISO）                                              |
| durationMs             | 単調時計で測った所要時間                                             |
| status / failed        | HTTPステータスと400以上の判定                                        |

ログはサーバーの標準出力へJSON一行で記録する。共通例外ログには例外本文を渡さない。URL原文、query、Cookie、本文、氏名、メールアドレス、UUID、招待トークンを性能ログに含めない。新規画面/APIが固定経路リストへ追加されていない場合は単体検査が失敗する。ログ出力の失敗で業務処理を再実行しない。

画面はNext.jsの `useReportWebVitals` によりFCP/LCP/TTFB/INP/CLSをブラウザのコンソールへ `screen_performance` として記録する。計測開始時の固定画面名、metric、数値、単位、開始/観測時刻のみを記録する。Web Vitalsのid、entries、DOM、URL原文は渡さない。外部の収集サービスや匿名のログ受付APIは使わない。SPA内遷移の所要時間ではなく、ドキュメントのWeb Vitalsである。

開発時はブラウザの開発者ツールConsoleで `screen_performance` を絞り込む。APIはアプリのサーバーログで `api_performance` を絞り込む。TTFB/LCP/FCPとAPI所要時間は測定区間が違うため、同じ値として比較しない。

## 検証手順

`npm test -- tests/unit/performance.test.ts tests/unit/pwa.test.ts` で、機微値を含むURL/例外の負例、Origin認証順序、全ルート分類、SWの非キャッシュ動作、アイコンの実寸を確認する。

`npx playwright test pwa-performance accessibility` で、未ログインでmanifest/SW/iconを取得できること、SW登録、CacheStorage空、オフラインで画面/APIを再取得できないこと、ログのPII除外、ログイン画面のキーボード操作と入力エラーの関連付けを確認する。OTP APIはモックし、実メールを送らない。

### 300案件・30同時利用者

ローカルSupabaseとビルド済みアプリを用意し、以下を実行する。

```powershell
$env:E2E_RUN_PERFORMANCE = '1'
npx playwright test performance-load --project=chromium
```

`NEXT_PUBLIC_SUPABASE_URL` と `APP_BASE_URL` が両方loopbackの場合に限って実行する。共有Supabaseでは明示フラグがあってもスキップする。3つの専用式場、300案件、2400宿題、15人のplannerと15人のcoupleを作成する。認証を先に済ませた30個の独立ブラウザで、ダッシュボードとマイページの初回表示を同時に開始し、続いてplanner15人の一覧APIを測定する。

結果はPlaywrightの添付 `performance-300cases-30users.json`。p50/p95/max、3秒超の件数、サーバー応答完了と画面表示までの時間を保存する。所要時間未達を隠して「3秒以内」とは判定しない。テストの合否は画面/APIの正常表示とfixture清掃を対象とし、3秒目標の達否は添付内の `over3Seconds` で確認する。ブラウザCPUとSSR/DBが同じCIホストを共有する条件を必ず併記し、ネットワーク込みの実端末性能とは分ける。

測定は既存demo seedを再利用しない。固定IDを持つ共同デモデータを300件へ増やしたり削除したりすることを避け、実行ごとのUUIDを持つ専用fixtureを作る。終了時は失敗した場合も当該IDのみを清掃する。Auth Admin APIは確認メールを送らない。

実端末の読み上げ、LINE内ブラウザ、Safariのホーム画面追加、実回線の初回表示は本人の端末で確認し、QA-07/QA-08の手動記録へ残す。

## 文字の見やすさ（QA-08）

従来の補助文字色は白背景で2.13:1、主ボタンとエラー文字は約3.93:1だった。通常サイズの文字に4.5:1以上を確保するため、`text-muted` を `#6F6B62`、`primary` を `#B53B65`、`danger` を `#B53035` に変更する。操作欄の境界は `border-mid: #89857B` を使用し、背景との3:1を確保する。装飾用の薄いカード境界は対象を分ける。

根拠は[W3C WCAG 2.2 文字コントラストの解説](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)。`tests/unit/accessibility-colors.test.ts` は相対輝度から比率を計算し、白・通常背景・入力背景、状態バナー、主ボタンのhover合成色、入力境界を検査する。色の検査は画面全体のWCAG適合認証や実機読み上げ試験を意味しない。
