import { z } from 'zod';

import { ok, route } from '@/lib/api/route';
import { isLocalDemoRequestAllowed } from '@/lib/auth/local-demo';
import { landingPathFor } from '@/lib/auth/session';
import { demoLogin } from '@/lib/d1/mode';
import { ApiError, forbidden, rateLimited } from '@/lib/errors';
import { parsePasswordBody } from '../password-body';

const schema = z.object({ role: z.enum(['planner', 'couple', 'admin', 'system_admin']) });

/** 役割ごとのデモアカウント。d1-local.mjs が環境変数に渡す */
const DEMO_EMAIL_ENV = {
  planner: 'DEMO_PLANNER_EMAIL',
  couple: 'DEMO_COUPLE_EMAIL',
  admin: 'DEMO_ADMIN_EMAIL',
  system_admin: 'DEMO_SYSTEM_ADMIN_EMAIL',
} as const;

/** npm run demo 専用。入力を確かめず、役割ごとのデモアカウントとして通常の認証でログインする。 */
export const POST = route(async (request) => {
  if (!demoLogin()) throw new ApiError('NOT_FOUND');
  if (!isLocalDemoRequestAllowed(request)) throw forbidden();
  const { role } = await parsePasswordBody(request, schema);
  const email = process.env[DEMO_EMAIL_ENV[role]];
  const password = process.env.DEMO_LOGIN_PASSWORD;
  if (!email || !password) throw new ApiError('INTERNAL_ERROR');

  const { signInD1WithPassword } = await import('@/lib/d1/auth');
  const result = await signInD1WithPassword(email, password, '127.0.0.1');
  if (result.status === 429) throw rateLimited();
  if (!result.ok)
    throw new ApiError('INTERNAL_ERROR', 'デモのアカウントでログインできませんでした');
  // 「/」での振り分けを挟まず着地点へ直接移り、遷移を1回減らす
  const response = ok({ redirectTo: landingPathFor(role) });
  response.headers.set('Cache-Control', 'no-store');
  for (const cookie of result.headers.getSetCookie()) response.headers.append('set-cookie', cookie);
  return response;
});
