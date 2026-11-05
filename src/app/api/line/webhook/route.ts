import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: { code: 'GONE', message: 'LINE連携は終了しました' } },
    { status: 410 },
  );
}
