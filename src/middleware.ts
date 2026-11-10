/**
 *
 * 正本: 基本設計書 Version 1.2 4-2「画面遷移の概要」
 *   - 未ログイン状態でアクセスできるのは P01／P02／P03／P04 のみ。
 *
 * 認可（どのデータに触れられるか）は RLS が最終防衛線であり、
 * ここでの遮断は導線を正すためのものにすぎない（6-5）。
 */
import { demoMailbox, isLocalD1Origin, localD1 } from '@/lib/d1/mode';
import { NextResponse, type NextRequest } from 'next/server';
/**
 * 未ログインでもアクセスできるパス（4-2）。
 *
 * /api/internal/** と /api/health は**利用者のセッションを持たない**経路。
 * 前者は pg_cron から pg_net 経由で叩かれ、共有シークレット（INTERNAL_CRON_SECRET）で
 * 認証する（6-5-2「ユーザー向けJWT検証とは別経路に分離する」）。
 * ここでログイン画面へ流すと、定期処理も死活監視も 307 を受け取って全滅する。
 * 実際の認証は各ハンドラの requireInternalCall() が行う。
 *
 * /rsvp/** はゲストの出欠回答画面。ゲストはアカウントを持たず、回答URLのトークンだけで到達する。
 */
const PUBLIC_PREFIXES = [
  '/login',
  '/register',
  '/password',
  '/error',
  '/rsvp',
  '/api/auth',
  '/api/internal',
  '/api/health',
];
export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/line/')) {
    return NextResponse.json(
      { error: { code: 'GONE', message: 'LINE連携は終了しました' } },
      { status: 410 },
    );
  }
  {
    const path = request.nextUrl.pathname;
    const origin = process.env.APP_BASE_URL;
    if (!origin) return new NextResponse('APP_BASE_URLが未設定です', { status: 500 });
    if (
      localD1() &&
      (!isLocalD1Origin(origin) || `http://${request.headers.get('host')}` !== origin)
    ) {
      return new NextResponse('ローカル検証専用です', { status: 403 });
    }
    // 受信箱はローカル検証専用。本番D1では外部送信するため存在しない扱いにする。
    if (!localD1() && !demoMailbox() && (path === '/dev/mailbox' || path === '/api/dev/mailbox'))
      return new NextResponse(null, { status: 404 });
    const allowed = [
      '/',
      '/api/health',
      '/login',
      '/error',
      '/cases',
      '/dashboard',
      '/notifications',
      '/api/dashboard/follow-up-today',
      '/mypage/account',
      '/mypage',
      '/mypage/tasks',
      '/mypage/timeline',
      '/mypage/case',
      '/mypage/notifications',
      '/mypage/guests',
      '/mypage/seating',
      '/api/notifications',
      '/api/notifications/send',
      '/submissions',
      '/api/files/upload',
      '/api/cases',
      '/api/mypage/case',
      '/api/auth/password-login',
      '/api/auth/demo-login',
      '/api/auth/sign-out',
      '/api/auth/initial-register',
      '/api/auth/otp-request',
      '/api/auth/otp-verify',
      '/cases/new',
      '/users',
      '/users/new',
      '/api/admin/users',
      '/password',
      '/api/auth/password-reset',
      '/api/auth/password-update',
      '/dev/mailbox',
      '/api/dev/mailbox',
      '/api/ai/status',
      '/api/ai/jobs',
      '/api/internal/ai-worker',
      // Wave1 で D1 化した定期処理と通知ログ出力 (認証は各ハンドラ側: 内部 secret / system_admin)
      '/api/internal/rate-limit-cleanup',
      '/api/internal/audit-log-purge',
      '/api/internal/risk-recalculate',
      '/api/system/notification-logs.csv',
      // Wave2: 残り定期処理・system・管理系 CRUD (認証は各ハンドラ/画面側)
      '/api/internal/notifications-dispatch',
      '/api/internal/ai-job-reclaim',
      '/api/internal/usage-rollup',
      '/api/internal/monitoring',
      '/api/internal/case-purge',
      '/system',
      '/templates',
      '/plan-types',
      '/venues',
      '/venues/new',
      '/api/venues',
    ];
    const casePage =
      /^\/cases\/[^/]+(?:\/edit|\/sheet|\/meeting-notes|\/archive|\/follow)?$/.test(path) &&
      path !== '/cases/new';
    const caseApi =
      /^\/api\/cases\/[^/]+(?:\/(?:archive|follow-logs|assign-tasks|invitations)(?:\/[^/]+\/send)?|\/risk\/recalculate)?$/.test(
        path,
      );
    const tasks =
      /^\/(?:mypage\/tasks\/[^/]+|submissions\/[^/]+|api\/tasks\/[^/]+\/submit|api\/submissions\/[^/]+\/(?:review|defect-check)|api\/ai\/jobs\/[^/]+|api\/cases\/[^/]+\/tasks(?:\/[^/]+)?|api\/files\/[^/]+\/download)$/.test(
        path,
      );
    const registration = /^\/register\/[^/]+$/.test(path);
    const guests =
      /^\/(?:rsvp\/[^/]+|api\/rsvp\/[^/]+|api\/cases\/[^/]+\/(?:guest-form|guest-tags(?:\/[^/]+)?|guests\/[^/]+(?:\/tags)?))$/.test(
        path,
      );
    const staffUser = /^\/(?:users|api\/admin\/users)\/[^/]+$/.test(path) && path !== '/users/new';
    const seating =
      /^\/api\/cases\/[^/]+\/(?:seating-layouts(?:\/[^/]+)?|seating-chart(?:\/(?:submit|review))?)$/.test(
        path,
      );
    const adminPages =
      /^\/(?:templates\/[^/]+|venues\/[^/]+|api\/venues\/[^/]+)$/.test(path) &&
      path !== '/venues/new';
    if (
      !allowed.includes(path) &&
      !staffUser &&
      !adminPages &&
      !casePage &&
      !caseApi &&
      !registration &&
      !guests &&
      !tasks &&
      !seating &&
      !path.startsWith('/_next/')
    ) {
      return NextResponse.json(
        {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'この機能はD1への移行検証の対象外です',
            details: [],
          },
        },
        { status: 503 },
      );
    }
    return NextResponse.next({ request });
  }
}
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw[.]js$|.*\.(?:svg|png|jpg|webp)$).*)',
  ],
};
