/** D1への軽量probe。DB不通は外部監視へ503で知らせる。 */
import { localDB } from '@/lib/d1/runtime';
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const row = await (await localDB()).prepare('SELECT 1 AS ok').first<{ ok: number }>();
    if (row?.ok !== 1) throw new Error('probe failed');
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
