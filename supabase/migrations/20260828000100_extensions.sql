-- BridalHub / にこまる
-- 基本設計書 Version 1.2 12章「環境分離」に基づく拡張の有効化。
--
-- gen_random_uuid() は PostgreSQL 13 以降のコア関数だが、
-- 招待トークンのハッシュ（6-3-6）と検索用HMAC列（5-1）で digest()／hmac() を使うため
-- pgcrypto を明示的に有効化する。
create extension if not exists pgcrypto with schema extensions;

-- pgvector（venue_knowledge.embedding）は Phase 3拡張で使用するため
-- ここでは有効化しない。Phase 3 のマイグレーションで create extension vector を行う（5-3／6-4）。
