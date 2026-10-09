# E2E テスト（Playwright）

「人が実際にブラウザを操作したときに、ちゃんと動くか」を自動で確かめる（Issue #19、設計書 12-2）。

| ファイル                          | 何を確かめるか                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `core-flow.spec.ts`               | 案件登録 → 宿題割当 → 招待 → 初回登録 → 提出 → 不備あり → 再提出 → 確認。2人で同じ宿題を共有する動き                                 |
| `permissions.spec.ts`             | 未ログイン・役割違い・権限外・セッション切れのときの戻り先とエラー画面                                                               |
| `ai-availability.spec.ts`         | AIワーカーの心拍が途切れたとき「利用できません」に切り替わること                                                                     |
| `notification-log-export.spec.ts` | system_adminのCSV期間・JST境界・1,000件超とマイクロ秒・ダウンロード・認証と通信異常。実通知やAIの実行は不要                          |
| `venue-edit.spec.ts`              | 式場一覧→詳細→変更の保存・再読込、空欄メール/停止中、入力検証、Origin/権限/不存在、500後の再試行。専用の模擬式場・アカウントのみ使用 |
| `api-origin.spec.ts`              | 実ブラウザーのJSON/multipart送信、Origin欠落/別Originの403、内部secret/LINE署名欠落の401。未認証・不正入力のみで副作用なし           |
| `otp-service-unavailable.spec.ts` | 認証サービスの503後に入力を保持し、再操作できること。送信APIは差し替えて実メール送信を遮断                                           |

`helpers/` は画面操作の部品。**アプリ本体のプログラムは触らない**。

CSVテストは接続先がローカルSupabaseの場合のみ実行し、専用アカウントと送信済み通知を作ります。後始末はそのfixtureのIDだけを対象にします。件数超過の画面表示は応答を差し替え、実DBの10,000件境界は単体テストで検証します。

式場編集テストも通常はローカルSupabaseのみで実行します。対象が開発用DBであると確認したうえで、`E2E_ALLOW_REMOTE_VENUE_TESTS=1`を指定した場合だけHTTPSの外部開発DBでも実行できます。`npx playwright test tests/e2e/venue-edit.spec.ts`で対象を限定してください。式場とランダムなパスワードの管理者・プランナーを新規作成し、そのIDに紐付く監査ログを含めて終了時に削除します。共有seed・既存の式場や利用者は変更せず、メール送信やAIジョブの実行も行いません。

## GitHub 上での実行

Pull Request を作ると CI の `e2e` ジョブが自動で走る（`.github/workflows/ci.yml`）。
ローカル Supabase（`supabase start`）を GitHub Actions 上に立て、ビルド済みのアプリに対して実行する。

失敗したときは Actions の画面から `playwright-report` をダウンロードすると、
どの画面で止まったかのスクリーンショットとトレースが見られる。

## 手元での実行

Docker が要る（Supabase のローカルスタックを動かすため）。

```bash
npx supabase start            # 初回は数分かかる。終わると鍵が表示される
npx playwright install        # ブラウザを入れる（最初の1回だけ）
```

`.env.local` に次を書く（値は `npx supabase status` の表示から）。

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
E2E_SUPABASE_SERVICE_ROLE_KEY=<service_role key と同じ値>
PII_ENCRYPTION_KEY=<openssl rand -base64 32>
PII_HMAC_KEY=<openssl rand -base64 32>
INTERNAL_CRON_SECRET=<何か文字列>
APP_BASE_URL=http://127.0.0.1:3000
```

> `E2E_SUPABASE_SERVICE_ROLE_KEY` を別名にしているのは、本体の ESLint が
> `SUPABASE_SERVICE_ROLE_KEY` の直接参照を禁じているため（6-3-5 Service Role 誤用防止）。
> テストのデータ投入だけに使う。

```bash
npm run test:e2e              # dev サーバーは自動で立ち上がる
npx playwright test --ui      # 画面を見ながら1本ずつ動かしたいとき
```

## 書き方の約束

- 選択は `getByLabel` / `getByRole` / 表示文字で行う（`data-testid` は使っていない）。
  文言の正本は `src/lib/constants.ts` と各画面。文言を変えたらテストも直す。
- テストごとにプランナーと案件を新しく作る。実行し直しても前回のデータに影響されない。
- メールで届くワンタイムコードは、ローカル受信箱（Mailpit、`http://127.0.0.1:54324`）から読む。
  そのため `supabase/templates/magic_link.html` に `{{ .Token }}` を含めている
  （本番の Supabase でも同じテンプレート設定が必要。#14）。
- **わざと壊して赤くなることを確かめる**。例: `src/lib/constants.ts` の `提出済` を
  別の文字にすると `core-flow.spec.ts` が落ちる。落ちないテストは何も見ていない。
