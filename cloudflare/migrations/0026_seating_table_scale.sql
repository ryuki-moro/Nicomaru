-- 卓の大きさ（会場図で表示する大きさの倍率）。1 が標準、0.5〜2 倍まで。
-- 既存の卓は標準（1）になる。src/lib/seating/layout.ts の TABLE_SCALE_MIN・TABLE_SCALE_MAX と揃える。
ALTER TABLE seating_tables ADD COLUMN scale REAL NOT NULL DEFAULT 1 CHECK(scale BETWEEN 0.5 AND 2);
