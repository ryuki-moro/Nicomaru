/**
 * サーバーコンポーネント／Route Handler 用の Supabase クライアント。
 *
 * 正本: 基本設計書 Version 1.2 6-5「API設計」。
 * 単純なCRUDは本クライアント経由（RLS適用）で行い、
 * Service Role Key は 6-3-5 の使用範囲表にある処理でのみ用いる。
 */
import { cookies } from 'next/headers';

import { createServerClient, type CookieOptions } from '@supabase/ssr';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が設定されていません（.env.example を参照）`);
  return value;
}

/**
 * ログイン中の利用者のセッションで動くクライアント。
 * ここから発行するクエリはすべて付録A の RLS が適用される（最終防衛線）。
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    env('NEXT_PUBLIC_SUPABASE_URL'),
    env('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options as CookieOptions);
            }
          } catch {
            // Server Component からは Cookie を書けない。middleware 側で更新されるため無視する。
          }
        },
      },
    },
  );
}

/**
 * RLS 適用クライアントの型。
 *
 * 各所で `Awaited<ReturnType<typeof createSupabaseServerClient>>` を書き直していたため、
 * 名前が3つ（ServerClient／UserClient／SupabaseServerClient）に割れていた。
 * 型の出どころはここ1箇所にする。
 */
export type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;
