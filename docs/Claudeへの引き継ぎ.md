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
- 本番配備の設定：ルートの `wrangler.jsonc`（`database_id` は仮値）、`open-next.config.ts`、`npm run cf:build`／`cf:deploy`／`db:d1:migrate:remote`／`db:d1:bootstrap-admin`。

## 検証結果（2026-10-30）

- 型検査成功。単体テスト1,111件成功・17件スキップ。`npm run test:d1` 37件成功（本番送信6件を追加）。`npm run test:d1:browser` 5件成功。
- `NICOMARU_DB=d1` の `next build` 成功（静的生成でDBへ接続しないことを確認）。
- `npm run cf:build`（OpenNext）はWindowsで実行不可：Windowsのアプリ制御ポリシーが `@ast-grep/napi` のネイティブ部品を遮断する。設定は変更しない。WSLへのNode導入はフックで止められたため未実施。Linux（WSL・CI）で実行する必要がある。
- ブラウザ試験の旧タイムアウトは、別の開発サーバー（dev-admin）と互いの生成物を監視し合う再コンパイルの連鎖が原因だった。`next.config.ts` で生成物・`.wrangler`・`.work` を監視対象外にした。宿題画面の遷移待ちは、戻り先変更（`?submitted=`／`?reviewed=`）に合わせて更新した。
- `npm run lint`（`eslint .`）は `.claude`・`.codex-work`・`.work` 配下を読んで設定エラーで停止する（既存の問題）。`src tests scripts` に限れば成功。

## 配備手順（ユーザーのログインが必要な段階）

1. `npx wrangler login`（本人がブラウザで認証。資格情報をチャットに貼らない）。
2. `npx wrangler d1 create nicomaru` の `database_id` を `wrangler.jsonc` に反映、`npx wrangler r2 bucket create nicomaru-files`。
3. `npm run db:d1:migrate:remote`。
4. `npx wrangler secret put` で `BETTER_AUTH_SECRET`・`PII_ENCRYPTION_KEY`・`PII_HMAC_KEY`・`RESEND_API_KEY` を設定し、`RESEND_FROM`・`APP_BASE_URL` を変数に設定する。既存データを移行する場合、PII鍵は移行元と同じ値が必要。
5. `npm run db:d1:bootstrap-admin -- --email <メール> --name <氏名>` で生成したSQLを `npx wrangler d1 execute DB --remote --file .wrangler/bootstrap/admin.sql` で適用。初期パスワードは `.wrangler/bootstrap/admin-password.txt` にだけ保存される。
6. Linux上で `npm run cf:build && npm run cf:deploy`。

## 未完了・未確認

- 未移行：AI、生成PDF、マジックリンク、パスワード再設定・変更、利用者・式場・テンプレート・プラン管理画面、定期処理（期限通知・削除バッチ等）、既存データと添付ファイルの移行。これらは本番D1でも503。
- 未確認：Workers上で `process.env` に変数・秘密値が入ること、Workers無料枠のCPU上限（better-authのパスワードハッシュが10msを超える可能性。超える場合は有料プランかハッシュ方式の変更が必要）。
- 既存の指摘（今回の差分外）：`src/lib/validation.ts` の `isoDate` が存在しない日付（例 `2028-02-31`）を通す。
