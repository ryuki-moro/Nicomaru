import { z } from 'zod';

import { ok, route } from '@/lib/api/route';
import { isDevAdminRequestAllowed } from '@/lib/auth/dev-admin';
import { demoLogin } from '@/lib/d1/mode';
import { ApiError, forbidden, rateLimited } from '@/lib/errors';
import { parsePasswordBody } from '../password-body';

const schema = z.object({ role: z.enum(['planner', 'couple']) });

/** npm run demo 専用。入力を確かめず、デモのプランナーか新郎新婦として通常の認証でログインする。 */
export const POST = route(async (request) => {
  if (!demoLogin()) throw new ApiError('NOT_FOUND');
  if (!isDevAdminRequestAllowed(request)) throw forbidden();
  const { role } = await parsePasswordBody(request, schema);
  const email = role === 'planner' ? process.env.DEMO_PLANNER_EMAIL : process.env.DEMO_COUPLE_EMAIL;
  const password = process.env.DEMO_LOGIN_PASSWORD;
  if (!email || !password) throw new ApiError('INTERNAL_ERROR');

  const { signInD1WithPassword } = await import('@/lib/d1/auth');
  const result = await signInD1WithPassword(email, password, '127.0.0.1');
  if (result.status === 429) throw rateLimited();
  if (!result.ok)
    throw new ApiError('INTERNAL_ERROR', 'デモのアカウントでログインできませんでした');
  const response = ok({ redirectTo: '/' });
  response.headers.set('Cache-Control', 'no-store');
  for (const cookie of result.headers.getSetCookie()) response.headers.append('set-cookie', cookie);
  return response;
});
