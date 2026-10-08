import { forbidden } from '@/lib/errors';

/** Cookie認証の更新APIで、呼び出し元を同一Originに限定する。 */
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  let supplied: URL;
  try {
    supplied = new URL(origin ?? '');
  } catch {
    throw forbidden('この送信元からの更新は許可されていません');
  }

  // Origin は scheme + host + port のみ。null・パス・資格情報・複数Originも拒否する。
  if (!['http:', 'https:'].includes(supplied.protocol)
    || supplied.origin !== origin
    || supplied.origin !== new URL(request.url).origin) {
    throw forbidden('この送信元からの更新は許可されていません');
  }
}
