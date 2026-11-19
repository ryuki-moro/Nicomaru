# Issue #187: 入力エラー項目へ移動

## 確認結果

- `npm test`: 成功（64 test files passed、2 skipped、1151 passed、17 skipped）
- `npm run lint`: 成功
- `npm run typecheck`: 成功
- `npx prettier --check tests/d1/issue-187.browser.mjs docs/ui-review/issue-187/README.md`: 成功
- `node --test tests/d1/issue-187.browser.mjs`: 成功（1 browser test）。ローカルD1の登録・編集画面とAPI応答モックを組み合わせ、両フォームの複数エラーから先頭項目へフォーカス、画面内表示、`aria-invalid` と `aria-describedby`、登録画面の補足説明関連付け、入力値保持と修正後再送信を確認。
- 登録と編集の項目非特定500エラーでは、無関係な入力欄へフォーカスが移らないことを確認。
- Page errorsなし。画面記録: `create-error.png`, `edit-error.png`。

## 試験範囲

画面とフォーム送信は実画面で操作。入力エラーと通信エラーのJSON応答、登録成功、宿題割当成功、編集成功はPlaywrightでモックしています。実バックエンドが同じ入力を拒否することや、実ネットワーク障害の再現は未確認です。

## 再実行

D1ローカル画面を `127.0.0.1:3104` に起動後、`node --test tests/d1/issue-187.browser.mjs` を実行します。Chromium実行ファイルは `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` で指定できます。
