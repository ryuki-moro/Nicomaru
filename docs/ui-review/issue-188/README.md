# Issue #188: 案件変更確認ダイアログのキーボード操作

## 実施した確認

- `npm test`: 成功（64 files、1,151件成功、17件スキップ）
- `npm run lint`, `npm run typecheck`, `npm run format:check`, `git diff --check`: 成功
- `node --test tests/d1/issue-188.browser.mjs`: 成功（Chromium、1 test passed）
- 開いた時に「やめる」にフォーカスし、TabとShift+Tabの両端循環を確認
- Escapeと「やめる」の両方で閉じ、背後の「更新する」へフォーカスが戻ることを確認
- 保存中はEscapeを押しても開いたままで、確認ボタンも無効になることを確認
- 更新成功後の遷移と、更新失敗時のエラー表示・フォーカス復帰を確認
- ブラウザの `pageerror` は発生しませんでした

成功時のPATCH応答と失敗時の500応答はPlaywrightで模擬しました。DBへの変更保存は検査対象に含みません。

## 画面記録

- `dialog.png`: 変更内容の確認ダイアログ

## 再実行

別ターミナルで `node --import tsx scripts/d1-local.mjs` を実行し、ローカルD1画面が `127.0.0.1:3104` で起動した後に `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` でChromeの実行ファイルを指定して `node --test tests/d1/issue-188.browser.mjs` を実行します。認証データは `.wrangler/app-local/credentials.json` を使います。
