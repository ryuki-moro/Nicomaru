/**
 * Supabase セッションの更新と、未ログインアクセスの遮断。
 *
 * 正本: 基本設計書 Version 1.2 4-2「画面遷移の概要」
 *   - 未ログイン状態でアクセスできるのは P01／P02／P03／P04 のみ。
 *
 * 認可（どのデータに触れられるか）は RLS が最終防衛線であり、
 * ここでの遮断は導線を正すためのものにすぎない（6-5）。
 */
import { NextResponse, type NextRequest } from 'next/server';

import { createServerClient } from '@supabase/ssr';

/**
 * 未ログインでもアクセスできるパス（4-2）。
 *
 * /api/internal/** と /api/health は**利用者のセッションを持たない**経路。
 * 前者は pg_cron から pg_net 経由で叩かれ、共有シークレット（INTERNAL_CRON_SECRET）で
 * 認証する（6-5-2「ユーザー向けJWT検証とは別経路に分離する」）。
 * 後者は Supabase Free の一時停止対策として GitHub Actions から叩く（6-12）。
 * ここでログイン画面へ流すと、定期処理も死活監視も 307 を受け取って全滅する。
 * 実際の認証は各ハンドラの requireInternalCall() が行う。
 */
const PUBLIC_PREFIXES = [
  '/login', '/register', '/password', '/error',
  '/api/auth', '/api/internal', '/api/health',
];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() を呼ぶことでトークンのリフレッシュと Cookie の更新が行われる
  const { data } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

  if (!data.user && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = path === '/' ? '' : `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\.(?:svg|png|jpg|webp)$).*)'],
};
