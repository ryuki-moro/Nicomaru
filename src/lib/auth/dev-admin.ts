/** 開発専用の管理者ログイン。資格情報は専用ランチャーからサーバーにだけ渡す。 */
export function getDevAdminConfig() {
  if (process.env.NODE_ENV !== 'development' || process.env.DEV_ADMIN_LOGIN_ENABLED !== 'true') {
    return null;
  }

  const email = process.env.DEV_ADMIN_EMAIL;
  const password = process.env.DEV_ADMIN_PASSWORD;
  const authUserId = process.env.DEV_ADMIN_AUTH_USER_ID;
  if (!email || !password || !authUserId) return null;
  return { email, password, authUserId };
}

export function isLoopbackHost(host: string): boolean {
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.host === host.toLowerCase() && !parsed.username && !parsed.password
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** 同一オリジンのブラウザ操作だけを受け付ける。ネットワーク制限はランチャーのbindが担う。 */
export function isDevAdminRequestAllowed(request: Request): boolean {
  const url = new URL(request.url);
  const host = request.headers.get('host');
  if (request.method !== 'POST' || !host || !isLoopbackHost(host) || !isLoopbackHost(url.host)) return false;
  // Next.jsは内部URLをlocalhostに正規化する場合がある。ブラウザのOriginは実際のHostと照合する。
  const browserOrigin = new URL(`${url.protocol}//${host}`);
  if (browserOrigin.port !== url.port || request.headers.get('origin') !== browserOrigin.origin) return false;
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return false;

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') return false;

  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedHost && forwardedHost.toLowerCase() !== host.toLowerCase()) return false;
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor && !forwardedFor.split(',').every((ip) =>
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip.trim()))) return false;

  return true;
}
