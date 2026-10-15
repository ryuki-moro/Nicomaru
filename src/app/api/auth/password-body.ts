import type { z } from 'zod';
import { ApiError, badRequest } from '@/lib/errors';
import { toErrorDetails } from '@/lib/validation';

/** 認証本文は最大16KiB。Content-Lengthが無い/偽装された場合も実バイト数で止める。 */
export async function parsePasswordBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  const invalid = () =>
    badRequest([{ field: '_', reason: 'リクエストの形式またはサイズが正しくありません' }]);
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) {
        await reader.cancel();
        throw invalid();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = schema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (!parsed.success) throw badRequest(toErrorDetails(parsed.error));
    return parsed.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalid();
  } finally {
    reader.releaseLock();
  }
}
