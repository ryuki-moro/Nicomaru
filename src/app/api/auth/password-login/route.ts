import { ok, route } from '@/lib/api/route';
import { clientIp } from '@/lib/d1/mode';
import { rateLimited, unauthenticated } from '@/lib/errors';
import { passwordLoginSchema } from '@/lib/validation';
import { parsePasswordBody } from '../password-body';
export const POST = route(async (request) => {
  const body = await parsePasswordBody(request, passwordLoginSchema);
  {
    const { signInD1WithPassword } = await import('@/lib/d1/auth');
    const result = await signInD1WithPassword(body.email, body.password, clientIp(request.headers));
    if (!result.ok) {
      if (result.status === 429) throw rateLimited();
      throw unauthenticated('メールアドレスまたはパスワードが正しくありません');
    }
    const response = ok({ redirectTo: '/' });
    for (const cookie of result.headers.getSetCookie())
      response.headers.append('set-cookie', cookie);
    return response;
  }
});
