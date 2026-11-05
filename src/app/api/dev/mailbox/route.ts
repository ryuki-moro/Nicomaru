import { ok, route } from '@/lib/api/route';
import { localDB } from '@/lib/d1/runtime';
import { readMailbox, requireLocalMailbox } from '@/lib/d1/mailbox';

export const GET = route(async (request: Request) => {
  requireLocalMailbox(request.headers);
  const response = ok({ messages: await readMailbox(await localDB()) });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
});
