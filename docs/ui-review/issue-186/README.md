# Issue #186: 検索解除

## 確認結果

- `npm test`: 成功（64 test files passed、2 skipped、1151 passed、17 skipped）
- `npm run lint`: 成功
- `npm run typecheck`: 成功（検索欄の再描画修正後に再実行）
- `npm run format:check`: 成功（検索欄の再描画修正後に再実行）
- `node --test tests/d1/issue-186.browser.mjs`: 成功（1 test passed）。入力途中の語を含む解除、検索欄と0件案内の両リンク、`q`/`page`除去、`scope`/`sort`維持、解除後の入力欄と一覧を確認。
- 修正前のブラウザ試験で、ソフト遷移後に入力途中の語が残ることを確認。検索語に応じて入力欄を再生成する修正後、同じ操作で空欄になることを再確認しました。
- Console error / pageerror はありませんでした。

## 画面記録

- `search-result.png`: 0件検索結果
- `cleared-archived.png`: アーカイブ範囲と並び順を保って解除
- `cleared-active.png`: アクティブ一覧へ戻り、並び順を保って解除

## 再実行

D1ローカル画面を `node --import tsx scripts/d1-local.mjs` で `127.0.0.1:3104` に起動後、`node --test tests/d1/issue-186.browser.mjs` を実行します。Chromium実行ファイルを指定する場合は `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` を設定してください。認証データは `.wrangler/app-local/credentials.json` を使います。
