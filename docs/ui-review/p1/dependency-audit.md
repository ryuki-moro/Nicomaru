# 依存監査の修正（2026年10月22日）

PR #131の`6f44684`で残っていたhigh 1件・moderate 3件を、開発用依存の同一系列内の更新で解消しました。更新後の`npm audit --json`は全severityで0件です。監査対象から開発用依存を除外したり、CIの判定基準を下げたりしていません。

## 更新内容

| パッケージ                            | 更新前                    | 更新後     | 目的                                             |
| ------------------------------------- | ------------------------- | ---------- | ------------------------------------------------ |
| `vitest`                              | 4.1.11（指定は`^4.1.11`） | 4.1.12固定 | mock登録・redirect許可リストの修正を含む版に更新 |
| `@vitest/coverage-v8`                 | 4.1.11固定                | 4.1.12固定 | Vitestと同じ版に揃え、peer dependencyを満たす    |
| `@vitest/mocker`ほかVitest内部依存    | 4.1.11                    | 4.1.12     | Vitest更新により推移依存も同じ版へ更新           |
| `vite`（推移依存）                    | 8.3.2                     | 8.3.5      | 監査対象の8.3.2を、互換範囲内の修正版に更新      |
| `rolldown`と対応するネイティブbinding | 1.2.12                    | 1.2.15     | Vite更新に伴う依存解決                           |
| `@oxc-project/types`                  | 0.152.0                   | 0.155.0    | Rolldown更新に伴う型依存                         |

`package.json`の変更はVitestとcoverage-v8の2件です。Viteを直接依存として追加せず、`package-lock.json`で安全な版に解決しています。アプリのruntime依存、UI、API、DB、Node.jsの指定は変更していません。

ViteとRolldownのNode.js要件は`^20.19.0 || >=22.12.0`で、プロジェクト指定の`^22.13.0 || >=24.0.0`を満たします。ローカルはNode.js 24.13.1、CIはNode.js 22です。

ロックファイルの確認では、意図しないパッケージ削除・major更新がないこと、更新していないパッケージのメタデータが変わっていないことを確認しました。npmが削ったLinux向け`libc`条件は、同一版の既存情報および更新先の公式パッケージ情報と照合して維持しています。全optional platformエントリも維持しています。

## 監査結果

| severity   | 更新前 | 更新後 |
| ---------- | ------ | ------ |
| critical   | 0      | 0      |
| high       | 1      | 0      |
| moderate   | 3      | 0      |
| low / info | 0      | 0      |
| 合計       | 4      | 0      |

moderate 3件はVitest・mocker・coverage-v8の依存関係として報告されていた件数です。アドバイザリそのものの件数とは区別しています。

根拠はnpm監査が返した公式アドバイザリです。

- Vitest：[mock登録](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)、[Windowsのredirect許可リスト](https://github.com/advisories/GHSA-xp26-3454-mjgp)
- Vite：[Windowsのコマンド実行](https://github.com/advisories/GHSA-587h-7wmj-h5pm)、[環境変数展開](https://github.com/advisories/GHSA-698v-4r3x-3vcv)、[エディター引数](https://github.com/advisories/GHSA-r825-w8mm-5pxw)、[クロスオリジン](https://github.com/advisories/GHSA-9jrq-w75r-8gcw)、[ファイル許可範囲](https://github.com/advisories/GHSA-rq7h-c2jc-7f22)、[WASM要求](https://github.com/advisories/GHSA-vfpm-58rq-9qcg)

## ローカル検査結果

| 検査                                                    | 結果                                                  |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `npm audit --json`                                      | 成功、全severityで0件                                 |
| `npm ls vitest @vitest/coverage-v8 @vitest/mocker vite` | 成功、peer dependencyの不整合なし                     |
| `npm run lint`                                          | 成功                                                  |
| `npm run typecheck`                                     | 成功                                                  |
| `npm run format:check`                                  | 成功                                                  |
| `npm run progress:check`                                | 成功                                                  |
| `npm run test`                                          | 成功、43ファイル成功・2skip、856件成功・15skip・失敗0 |

15件のskipは`TEST_PG_URL`未設定の実PostgreSQL用2ファイルで、成功件数には含めていません。CIの専用`concurrency-db`ジョブで別途実行します。

`npm run test:coverage`も成功し、設定対象の`risk.ts`・`schedule.ts`・`auth/session.ts`はStatements・Branches・Functions・Linesのすべてで100%を維持しました。カバレッジ実行時も856件成功・15skipです。ロックファイルのLinux向け条件を維持した最終版でも、依存監査が全severity 0件であることを再確認しました。

## 再検査

```bash
npm ci --no-audit
npm audit --json
npm ls vitest @vitest/coverage-v8 @vitest/mocker vite
npm run lint
npm run typecheck
npm run format:check
npm run progress:check
npm run test
npm run test:coverage
```

CIでは既存のverify・security・concurrency-db・e2eジョブを同じ基準のまま再実行します。before/after画像は画面の表示を変えていないため再生成しません。最終CI結果はPR本文に実行リンク付きで記録します。
