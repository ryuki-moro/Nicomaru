/**
 * GET /api/health — 死活監視の受け口（6-12）。
 *
 * Supabase Free はアクセスが無いとプロジェクトが一時停止され、
 * 止まると pg_cron 自体も動かず自分を起こせない（6-5-2）。
 * GitHub Actions の schedule から6時間ごとに叩き、DBへ軽い問い合わせを1本通すことで
 * プロジェクトを起こしたままにする。
 *
 * 認証は要らない。返すのは可否だけで、件数や内部状態は出さない（9章）。
 */
import { NextResponse } from 'next/server';

import { createSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    // データ/件数は取得しない。HEADではSQLSTATEが失われるため0件GETを使う。
    // anonに業務テーブルのSELECT権限が無い環境では42501になるが、
    // これはPostgreSQLが応答した証拠であり、接続の死活確認としては正常。
    // 業務の認可や最新migrationの適用確認を兼ねるエンドポイントではない。
    const { error } = await supabase.from('venues').select('id').limit(0);
    if (error && error.code !== '42501') throw new Error('DB probe failed');
    return NextResponse.json({ ok: true });
  } catch {
    // 詳細はクライアントへ返さない。失敗の事実だけを 503 で伝える。
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
