import { forbidden } from '@/lib/errors';

/** 認証前のAPIも含むブラウザーの更新リクエストを、同一Originに限定する。 */
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  let supplied: URL;
  let expected: URL;
  try {
    supplied = new URL(origin ?? '');
    // Next.jsはループバックのrequest.urlをlocalhostへ正規化することがあるため、
    // 配備側が設定した公開URLを優先する。Host／転送ヘッダーからは許可元を決めない。
    // 空文字を含む不正設定をrequest.urlへフォールバックさせない。
    expected = new URL(process.env.APP_BASE_URL ?? request.url);
  } catch {
    throw forbidden('この送信元からの更新は許可されていません');
  }

  // Origin は scheme + host + port のみ。null・パス・資格情報・複数Originも拒否する。
  if (
    !['http:', 'https:'].includes(supplied.protocol) ||
    !['http:', 'https:'].includes(expected.protocol) ||
    expected.username !== '' ||
    expected.password !== '' ||
    supplied.origin !== origin ||
    supplied.origin !== expected.origin
  ) {
    throw forbidden('この送信元からの更新は許可されていません');
  }
}
