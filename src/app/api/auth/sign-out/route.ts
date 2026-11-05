import { clientIp, usingD1 } from '@/lib/d1/mode';
import { d1Auth } from '@/lib/d1/auth';
import { route } from '@/lib/api/route';
import { notFound } from '@/lib/errors';

export const POST = route(async (request: Request) => {
  if (!usingD1()) throw notFound();
  const headers = new Headers(request.headers);
  headers.set('x-nicomaru-local-ip', clientIp(request.headers));
  // NextRequestをNodeのRequestへ直接渡すと、開発時の異なる実装間でprivate stateが壊れる。
  const forwarded = new Request(new URL('/api/auth/sign-out', process.env.APP_BASE_URL), {
    method: 'POST',
    headers,
    body: await request.text(),
  });
  return (await d1Auth()).handler(forwarded);
});
