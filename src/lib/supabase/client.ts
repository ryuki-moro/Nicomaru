/**
 * ブラウザ側の Supabase クライアント。
 * anon key のみを用い、アクセス範囲は付録A の RLS が決める（6-5）。
 */
'use client';

import { createBrowserClient } from '@supabase/ssr';

export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が設定されていません');
  }
  return createBrowserClient(url, anonKey);
}
