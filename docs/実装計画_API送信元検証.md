# 実装計画: 更新APIの送信元検証（GAP-06）

## 目的とスコープ

2026-10-09の実装再開指示に基づき、Issue #54の次の優先作業として、28個のブラウザー向け更新APIへ同一Origin検証を適用する。Doneは、不正・欠落Originを副作用前に403で拒否し、通常の画面操作・認証・内部処理・Webhookがそれぞれの認証方式で動くこと。

今回の単位は中規模のAPI共通処理変更。削除バッチの失敗処理（GAP-11）、依存更新、mainへのマージは別作業とする。DB変更・実メール送信は行わない。

## 前提と制約

- `303e874`を基点とする専用ブランチで実装する。技術スタックと既存の認証/RLSを維持する。
- ブラウザーは相対URLのJSONまたはmultipart POSTを使用する。OriginをJavaScriptから手動設定しない。
- `APP_BASE_URL`を公開Originの正本とし、既存`requireSameOrigin()`を再利用する。
- 内部cron5本は`x-internal-cron-secret`、LINE Webhook1本はraw bodyの署名で認証する。

## 現状把握

`src/lib/api/route.ts`は全ブラウザー向け更新APIを包むが、Origin検証は式場PATCH内の1件だけ。更新APIは計34メソッドあり、業務23件・認証5件・内部5件・Webhook1件に分かれる。認証APIもCookieの発行・更新やメール要求を伴う。外部メールのGET着地と、自アプリからのPOSTを区別する。

## 設計方針

| 分岐     | 採用                                                                 | 理由                                              |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| 適用方式 | `route()`の既定動作でGET/HEAD/OPTIONS以外を検証                      | 個別opt-inでの適用漏れを防ぐ                      |
| 実行順   | ハンドラーの本文解析・認証・副作用より前に検証                       | 不正OriginからDB/メール/Storage処理へ到達させない |
| 内部処理 | `{ source: 'internal-cron' }`を明示し、wrapper自身が共有secretを検証 | 単なる検証スキップの設定を作らない                |
| Webhook  | 既存の独立ハンドラーと署名検証を維持                                 | raw bodyと既存の応答契約を保つ                    |
| 認証API  | 全5本をOrigin検証対象に含める                                        | 未ログインという理由で更新APIを免除しない         |

## 実装ステップ

1. 共通処理: `route.ts`へ既定保護・内部認証を追加。内部5本の重複認証と式場PATCHの個別Origin検証を整理。既存OTPテストに正常Originを付与。全体単体テストと型/lintで正常・拒否・例外経路を検証する。
2. 適用範囲と実ブラウザー: 全28更新APIが不正Originで副作用前に拒否されること、内部5本とWebhookが別認証を保つことをテスト。ビルド済みアプリでJSON/multipart送信と式場編集を確認する。Step 1に依存。
3. 記録: レビュー指摘を解消し、検証証拠・例外一覧・新API追加時の規約を保存。PRとIssue #54、JSONを正本とする進捗台帳に反映する。Step 2に依存。

## リスクと未確定事項

- Originなしのcurl/サーバー呼出しはブラウザー向けAPIで403になる。正しいOriginを付ける例と内部認証の区別を文書化する。
- 不正Originかつ未認証の場合は認証前の403を優先する。正しいOriginの未認証は既存401を維持する。
- LINE Webhookは共通wrapper外なので、全Routeの適用範囲テストで明示例外を監視する。
- 既存依存監査の失敗はIssue #47で追跡し、この変更だけでCI全成功とは扱わない。

## 検証計画

- 単体・結合: unsafe method、Origin欠落/null/別host/scheme/port、設定不正、本文未読・副作用未実行、GETの互換性、内部secret必須、Webhook署名必須。
- ブラウザー: 未認証の正常Originは既存400/401へ到達、別Originは403。実DBの式場保存・再読み込みをPC/スマートフォン寸法Chromeで確認。模擬データだけを使用し清掃する。
- ロールバック: DB変更なし。専用ブランチの変更を戻せば元のAPI動作になる。

2026-10-09の実施結果: 全体の単体/SQL・RLSテスト597件成功（実PostgreSQL専用12件skip）、lint・型・build成功。PCとスマートフォン寸法Chromeで送信元検証10件、式場編集16件、認証503後の再操作2件、計28件が成功した。専用試験データの清掃も成功。実機Safariと実メール配送は未検証。

正確性・セキュリティ・性能・簡素化の独立レビューで要対応指摘なし。スキル指定の外部`review.py`は`httpx`未導入で実行できず、Codexレビューで代替した。mainへのマージとGitHub CI全体の合格はこのローカル結果に含めない。

## 参照

- [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#using-standard-headers-to-verify-origin): 送信元と公開Originの比較、ログイン画面のCSRFも考慮する。
- vault検索は環境の`C:/dev/vault-search/vs.py`が存在せず実行できないため、既存の進捗台帳・APIコードを根拠にした。
