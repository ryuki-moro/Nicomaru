/** 6桁OTPの送信要求。対象者の判定とD1レート制限を先に行う。 */
import { noContent, parseBody, route } from '@/lib/api/route';
import { clientIp, localD1 } from '@/lib/d1/mode';
import { otpRequestSchema } from '@/lib/validation';
export const POST = route(async (request) => {
  const body = await parseBody(request, otpRequestSchema);
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const db = await localDB();
    await (
      await import('@/lib/d1/auth-limits')
    ).authLimit(db, 'otp_request', body.email, localD1() ? undefined : clientIp(request.headers));
    if (await (await import('@/lib/d1/onboarding')).otpEligible(db, body.email)) {
      const auth = await (await import('@/lib/d1/auth')).d1Auth();
      await auth.api.sendVerificationOTP({
        body: { email: body.email.trim().toLowerCase(), type: 'sign-in' },
      });
    }
    return noContent();
  }
});
