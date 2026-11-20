// 番号を付け替えたマイグレーションの対応表（旧名→新名）。
// wrangler は d1_migrations に記録された「名前」で適用済みかを判断する。付け替える前の名前で
// 適用済みの手元DBでは新しい名前を未適用とみなし、同じ変更をもう一度流して失敗する（Issue #266）。
// マイグレーションの番号を付け替えたら、ここに1行足す。
export const RENAMED_MIGRATIONS = [
  { from: '0024_seating_table_scale.sql', to: '0026_seating_table_scale.sql' },
];

// 旧名だけが記録されていれば新名に書き換え、書き換えた組を返す。
// 適用記録の表がまだない新しいDBと、新名がすでに記録されているDBには何もしない。
export async function renameAppliedMigrations(db, renamed = RENAMED_MIGRATIONS) {
  const table = await db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'")
    .first();
  if (!table) return [];
  const done = [];
  for (const { from, to } of renamed) {
    const result = await db
      .prepare(
        'UPDATE d1_migrations SET name = ?2 WHERE name = ?1 AND NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?2)',
      )
      .bind(from, to)
      .run();
    if (result.meta.changes > 0) done.push({ from, to });
  }
  return done;
}
