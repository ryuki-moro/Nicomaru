import { NextResponse } from 'next/server';
import { route } from '@/lib/api/route';

export const POST = route(async () => {
  return NextResponse.json(
    { error: { code: 'GONE', message: 'LINE連携は終了しました' } },
    { status: 410 },
  );
});
