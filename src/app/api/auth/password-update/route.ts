import { noContent, route } from '@/lib/api/route';
import { passwordUpdateSchema } from '@/lib/validation';
import { z } from 'zod';
import { parsePasswordBody } from '../password-body';
// D1ではメールのリンクのトークンで本人を確かめる（セッションは作らない）。
const d1PasswordUpdateSchema = passwordUpdateSchema.and(
  z.object({ token: z.string().min(1).max(200) }),
);
export const POST = route(async (request) => {
  {
    const body = await parsePasswordBody(request, d1PasswordUpdateSchema);
    const { localDB } = await import('@/lib/d1/runtime');
    await (
      await import('@/lib/d1/staff')
    ).completePasswordSetup(await localDB(), body.token, body.password);
    return noContent();
  }
});
