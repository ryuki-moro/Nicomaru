# Claude Codeへの引き継ぎ：にこまるのD1移行

ユーザーの依頼は、LINE連携の廃止、メール通知・AI・PDFを含む機能のD1移行、既存データと添付ファイルの移行・検証、Cloudflareへの配備。ログインが必要な段階でユーザーに知らせる。未完了の報告を繰り返さず、承認済み範囲で実装・テストを継続する。

## 作業状態（2026-10-30 Claude更新）

- 作業場所は `C:\project\nicomaru`、ブランチは `main`、変更は未コミット。`tsconfig.json` と作業用ディレクトリの既存変更は無関係として扱う。
- 実行モードは `NICOMARU_DB` で切り替える（判定は `src/lib/d1/mode.ts` に集約）。
  - `d1`：Cloudflare Workers本番（OpenNext）。`getCloudflareContext` の `DB`・`FILES` を使い、招待・OTP・通知メールをResendで実送信する。受信箱 `/dev/mailbox` は404。
  - `d1-local`：`127.0.0.1:3104` 限定のローカル検証。メールは暗号化した `local_mailbox` に保存するだけ。
  - 未設定：従来のSupabase。
- LINEは送信・連携コード（`src/lib/notify/line.ts`、連携ボタン、`sendLine`）を削除し、入力スキーマは `email` のみ受け付ける。`/api/line/*` はmiddlewareで410。旧データの `line` は表示用に型だけ残し、旧通知の `line` はメールへ切り替える。DB列・歴史データ・既存SQL（`claim_line_quota` 等）は削除していない。
- 本番のレート制限は `cf-connecting-ip` を接続元にする（以前は全員が `127.0.0.1` 扱いで共有されていた）。OTP検証の上限は接続元×メール単位。
- 本番配備の設定：ルートの `wrangler.jsonc`、`open-next.config.ts`、`npm run cf:build`／`cf:deploy`／`db:d1:migrate:remote`／`db:d1:bootstrap-admin`。

## 検証結果（2026-10-30）

- 型検査成功。単体テスト1,111件成功・17件スキップ。`npm run test:d1` 37件成功（本番送信6件を追加）。`npm run test:d1:browser` 5件成功。
- `NICOMARU_DB=d1` の `next build` 成功（静的生成でDBへ接続しないことを確認）。
- `npm run cf:build`（OpenNext）はWindowsで実行不可：Windowsのアプリ制御ポリシーが `@ast-grep/napi` のネイティブ部品を遮断する。設定は変更せず、Cloudflare側でビルドする。
- ブラウザ試験の旧タイムアウトは、別の開発サーバー（dev-admin）と互いの生成物を監視し合う再コンパイルの連鎖が原因だった。`next.config.ts` で生成物・`.wrangler`・`.work` を監視対象外にした。宿題画面の遷移待ちは、戻り先変更（`?submitted=`／`?reviewed=`）に合わせて更新した。
- `npm run lint`（`eslint .`）は `.claude`・`.codex-work`・`.work` 配下を読んで設定エラーで停止する（既存の問題）。`src tests scripts` に限れば成功。

## 配備状況（2026-10-30）

- 本番URLは `https://nicomaru.nicomaru-app.workers.dev`。Cloudflare Workers Builds が `feature/d1-cloudflare-deploy` への push で自動配備する（ビルドは `npm run cf:build`、配備は `npm run db:d1:migrate:remote && npm run cf:deploy`、`NODE_VERSION=22`）。Windowsでの `cf:build` は不要。
- D1 `nicomaru` は作成・マイグレーション済み。初期 system_admin で本番ログイン確認済み。`APP_BASE_URL`・`BETTER_AUTH_SECRET`・`PII_ENCRYPTION_KEY`・`PII_HMAC_KEY` はランタイム変数に登録済み。
- `main` は未更新。本番ブランチを `main` に戻すにはPRのマージが必要。
- 配備に必要な better-auth のworkerd向けファイルは、`next.config.ts` の `outputFileTracingIncludes` で成果物へ含めている。

## 利用者の操作が必要なもの

- メール送信：Resendのドメイン認証後、`RESEND_API_KEY`（シークレット）と `RESEND_FROM`（テキスト）をランタイム変数へ登録する。未設定の間は確認コード・招待メールが届かない。
- 添付ファイル：R2を有効化し（利用規約への同意が必要）、バケット `nicomaru-files` を作り、`wrangler.jsonc` の `r2_buckets` を戻す。未設定の間は添付APIが503。

## 未完了・未確認

- 未移行：AI、生成PDF、マジックリンク、パスワード再設定・変更、利用者・式場・テンプレート・プラン管理画面、定期処理（期限通知・削除バッチ等）、既存データと添付ファイルの移行。これらは本番D1でも503。
- 確認済み：Workers上で変数・秘密値を読めること、パスワード照合がCPU上限で落ちないこと（管理者ログイン成功）。継続的な負荷での無料枠の余裕は未確認。
- 既存の指摘（今回の差分外）：`src/lib/validation.ts` の `isoDate` が存在しない日付（例 `2028-02-31`）を通す。
