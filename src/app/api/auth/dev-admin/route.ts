import { createClient } from '@supabase/supabase-js';

import { ok, route } from '@/lib/api/route';
import { getDevAdminConfig, isDevAdminRequestAllowed } from '@/lib/auth/dev-admin';
import { ApiError, forbidden } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/** 開発用adminの入力省略。通常のAuth/RLSを使い、匿名利用者に管理者権限を偽装しない。 */
export const POST = route(async (request) => {
  const config = getDevAdminConfig();
  if (!config) throw new ApiError('NOT_FOUND');
  if (!isDevAdminRequestAllowed(request)) throw forbidden();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new ApiError('INTERNAL_ERROR');

  // プロフィールを確認するまではCookieを書かない。
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: config.email,
    password: config.password,
  });
  if (error || !data.user || !data.session) {
    throw new ApiError('INTERNAL_ERROR', '開発用adminでログインできませんでした。起動設定を確認してください');
  }

  let accepted = false;
  try {
    if (data.user.id !== config.authUserId) throw forbidden();
    const profile = await client.from('user_profiles')
      .select('role, status, venue_id')
      .eq('auth_user_id', data.user.id)
      .maybeSingle();
    if (profile.error || !profile.data || profile.data.role !== 'admin'
      || profile.data.status !== 'active' || !profile.data.venue_id) throw forbidden();

    const supabase = await createSupabaseServerClient();
    const established = await supabase.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    if (established.error) throw new ApiError('INTERNAL_ERROR');
    accepted = true;

    // トークン・資格情報は応答に含めない。遷移先も利用者入力では決めない。
    const response = ok({ redirectTo: '/dashboard' });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } finally {
    if (!accepted) await client.auth.signOut({ scope: 'local' });
  }
});
