# Issue #189: 一時保存後の添付名

## 確認結果

- `npm test`: 成功（64 test files passed、2 skipped、1151 passed、17 skipped）
- `npm run lint`: 成功
- `npm run typecheck`: 成功
- `npm run format:check`: 成功
- `node --test tests/d1/issue-189.browser.mjs`: 成功（1 browser test）。ローカルD1で初回添付・差し替え・保存失敗後の再試行・アップロード失敗後の再試行・reload後の名前を確認し、アップロード回数の重複がないことも検証。
- RSC refreshを保留した状態でも、初回と差し替えの保存成功通知に最新添付名を表示。
- 修正前の実画面確認では、初回添付の一時保存成功通知直後に「まだ選んでいません」と表示され、その後のrefresh完了で添付名が現れました。
- 試験のPlaywright APIモックによる保存失敗・アップロード失敗を通して、成功通知を出さず再試行できることを確認。

## 画面記録

- `initial-save-before-refresh.png`, `initial-saved.png`
- `submit-failed-pending-file.png`, `replacement-save-before-refresh.png`, `replacement-reloaded.png`
- `upload-retry-saved.png`

## 試験範囲

画面、アップロード、保存、reloadは実アプリとローカルD1を使用。RSC refreshはPlaywright routeで応答を保留し、成功直後の表示を検査。アップロード失敗と保存失敗のHTTP応答のみPlaywrightでモックしています。

## 再実行

D1ローカル画面を `127.0.0.1:3104` に起動し、`node --test tests/d1/issue-189.browser.mjs` を実行します。Chromium実行ファイルは `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` で指定できます。
