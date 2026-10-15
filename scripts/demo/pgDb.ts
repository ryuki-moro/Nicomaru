/**
 * {@link DemoDb} の実 PostgreSQL 版（ローカル Supabase／共有デモ環境の DB に直接つなぐ）。
 *
 * 利用者として実行するときは、Supabase の PostgREST がリクエストごとに行うのと同じく
 * `authenticated` ロールへ切り替え、JWT のクレームを GUC に置く。
 * auth.uid() は request.jwt.claim.sub（旧）と request.jwt.claims（新）のどちらからでも読めるので両方に入れる。
 */
import type { Client } from 'pg';

import type { DemoDb } from './seed';

export function pgDemoDb(client: Client): DemoDb {
  const clearClaims = async () => {
    await client.query('reset role');
    await client.query(
      `select set_config('request.jwt.claim.sub', '', false),
              set_config('request.jwt.claims', '', false)`,
    );
  };

  return {
    async query(sql, params = []) {
      const res = await client.query(sql, params);
      return { rows: res.rows };
    },

    async asOwner(fn) {
      await clearClaims();
      return fn();
    },

    async asUser(authUserId, fn) {
      await clearClaims();
      await client.query(
        `select set_config('request.jwt.claim.sub', $1, false),
                set_config('request.jwt.claims', $2, false)`,
        [authUserId, JSON.stringify({ sub: authUserId, role: 'authenticated' })],
      );
      await client.query('set role authenticated');
      try {
        return await fn();
      } finally {
        await clearClaims();
      }
    },
  };
}
