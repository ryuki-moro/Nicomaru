# にこまる (BridalHub)

ブライダル業界向けの業務支援アプリ。ウェディングプランナーと新郎新婦(couple)をつなぎ、
**案件管理・招待・宿題(提出物)管理・準備シート・AI補助**を提供する。卒業制作プロジェクト。

> 基本設計 **Version 1.2** 完了・**Phase 1 実装完了**。
> 設計書 (`docs/`) と残タスク (`TASKS.md` / Issues) が正本。

## 現状サマリ

| 区分 | 状態 |
| --- | --- |
| 基本設計書 | ✅ **完了 (Version 1.2)** — 全13章＋付録A〜D、26テーブル |
| 設計レビュー | ✅ **完了** — 7観点並列レビューで55件指摘、全件を設計書へ反映 |
| 着手ブロッカー (rank 1〜10) | ✅ **解消** — v1.1 を原文照合で検証し、残っていた5件を v1.2 で修正 |
| 第13章 合意必須事項 (Phase 1 分) | ✅ **決定済み** — 13-1「開発チーム決定」として確定 (差し戻し影響範囲つき) |
| 実装 | ✅ **Phase 1 完了** — 全34ルート、テスト175件。実環境での通し確認は未実施 |

## セットアップ

```bash
npm install
```

環境変数は `.env.example` をコピーして `.env.local` を作る。
個人情報の暗号化鍵は 32 バイトを base64 で与える。

```bash
openssl rand -base64 32
```

### 開発サーバー

```bash
npm run dev
```

### 検証

```bash
npm test
```

`npm test` は次の2種類を通しで実行する。

- **RLSテスト** (`tests/db/`) — [PGlite](https://pglite.dev/)(WASM PostgreSQL) 上に
  `supabase/migrations/` をそのまま適用し、第11章の合格基準を機械検証する。
  Docker も Supabase CLI も不要なので、CI と開発機で同じテストが動く。
  42P17(ポリシーの相互再帰)・権限昇格・アーカイブ済み案件の保護・停止利用者の遮断・
  memo の列レベル遮断・招待の可視範囲を毎回確認する。
- **ユニットテスト** (`tests/unit/`) — タイムライン逆算、案件更新時の期限再計算、
  リスクスコア算出、暗号化と検索用ハッシュ、招待トークン。
  設計書の仕様からテストを先に用意し、実装を合わせている(12-2)。

```bash
npm run lint       # ESLint (Service Role Key の範囲外使用を機械検出)
npm run typecheck  # tsc --noEmit (strict)
npm run build      # 本番ビルド
```

## リポジトリ構成

| パス | 内容 |
| --- | --- |
| `docs/にこまる_要件定義書_完成版.docx` | 要件定義書(設計の照合元・正) |
| `docs/BridalHub_基本設計書.docx` | 基本設計書 本体(**Version 1.2**。改訂履歴は文書情報を参照) |
| `docs/BridalHub_基本設計書_レビュー結果.md` | 設計レビュー結果(55件の指摘詳細・承認判断) |
| `docs/画面設計/` | サイトマップ・画面案(pptx) |
| `design-system/` | 6画面のモックアップから抽出したデザインシステム(色・型・部品) |
| `supabase/migrations/` | DDL・RLS共通関数・全ポリシー・インデックス |
| `supabase/seed.sql` | 式場1件・プラン種別4種・宿題テンプレート・リスクルール |
| `src/lib/` | 定数(表6-9 の単一ソース)・エラー体系・暗号化・招待・スケジュール・リスク |
| `src/app/` | 画面(App Router)と Route Handler |
| `tests/` | RLSテストとユニットテスト |
| `TASKS.md` | 残タスク一覧・フェーズ計画・レビュー指摘の全件表 |

## 設計上の技術構成 (設計書 v1.2 より)

| 層 | 採用 | 備考 |
| --- | --- | --- |
| フロント/ホスティング | Next.js 15 (App Router) + Vercel (Hobby枠) | 制約起点で構成決定 |
| DB / 認可 | Supabase (PostgreSQL + RLS + Auth + Storage) | RLSで permissive/restrictive 結合 |
| 認証 | couple=マジックリンク＋6桁ワンタイムコード / staff=メール＋パスワード(12文字以上) | LINE内ブラウザのブラウザ跨ぎ対応 |
| 個人情報 | アプリ側 AES-256-GCM ＋ 検索用 HMAC-SHA256 列 | 等値一致検索のみ(13-1) |
| 定期処理 | pg_cron (死活監視のみ GitHub Actions) | 一覧は 6-12 |
| AI補助 | ローカルLLM (Ollama) をプル型ジョブで内製、RAG は pgvector | Phase 3。生成エンジンは校内サーバー非公開 |
| 通知 | LINE Messaging API / メール(Resend) | Auth メールも Resend を Custom SMTP として使用 |

## 設計上の要点(実装で踏み外しやすいところ)

- **RLS の共通関数は再帰回避のために必須**。ポリシー式から `user_profiles` /
  `couple_profiles` / `wedding_cases` を直接参照すると 42P17 で主要画面が落ちる。
  すべて `accessible_case_ids()` などの security definer 関数を経由する(付録A)。
- **permissive ポリシーの WITH CHECK は OR 結合される**。値域だけを見る WITH CHECK は
  別ポリシーの USING と組み合わさって権限昇格になる。USING と WITH CHECK の両方に
  同じロール条件を置く(RLSテストで検出済み)。
- **`couple_profiles` は `select *` が 42501 になる**。`memo` を列レベル権限で剥奪しているため、
  参照列は `COUPLE_PROFILE_COLUMNS` を使う。
- **提出は「案件」単位**。新郎新婦は1つの案件・同じ宿題を共有し、最新提出も1件だけ持つ。
  上書き条件に提出者の一致を加えると、相手が一時保存しただけでもう一方が提出できなくなる(6-7)。
- **平文の招待トークンは保存しない**。既発行の招待URLを後から表示・再送することはできず、
  送信・URL再表示は必ず再発行(既存を `revoked_at` で失効 → 新規行)を伴う(6-3-6 / K02)。
- **Service Role Key は使用範囲表(6-3-5 表6-4)にある用途のみ**。
  `createSupabaseAdminClient(useCase)` で用途を明示し、範囲外の参照は ESLint が落とす。

## フェーズ計画

- **Phase 1**: コア導線(案件登録 → 招待 → 初回登録 → 提出 → 確認)。実装完了。
  残るのは実環境(Supabase プロジェクト)での通し確認と、メール送信ドメインの準備。
- **Phase 2**: 運用機能の拡充(LINE起点導線・リスク可視化・通知・準備シート・system_admin画面)。
- **Phase 3**: AI補助(9-1〜9-6)／Phase 3拡張(9-7〜9-11)。Phase 1〜2 と疎結合で、AI不調でもコア機能は維持。

詳細は `TASKS.md` と各 Issue を参照。
