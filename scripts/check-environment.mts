/** 設定値・資格情報を出力せず、接続先へも通信しない環境チェック。 */
const results: { key: string; status: 'ok' | 'missing' | 'invalid' | 'optional'; note: string }[] =
  [];
function report(key: string, status: 'ok' | 'missing' | 'invalid' | 'optional', note = '') {
  results.push({ key, status, note });
}
function value(key: string) {
  return process.env[key]?.trim() ?? '';
}
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'APP_BASE_URL']) {
  const raw = value(key);
  if (!raw) {
    report(key, 'missing');
    continue;
  }
  try {
    const url = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const valid =
      (url.protocol === 'https:' || (local && url.protocol === 'http:')) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/';
    report(key, valid ? 'ok' : 'invalid', local ? 'ローカル接続' : '外部接続（通信は未実施）');
  } catch {
    report(key, 'invalid');
  }
}
for (const key of [
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'INTERNAL_CRON_SECRET',
]) {
  const raw = value(key);
  report(key, raw && !raw.includes('<') ? 'ok' : 'missing', '有無のみ。実際の接続・一致は別途確認');
}
for (const key of ['PII_ENCRYPTION_KEY', 'PII_HMAC_KEY']) {
  const raw = value(key);
  report(
    key,
    !raw ? 'missing' : Buffer.from(raw, 'base64').length === 32 ? 'ok' : 'invalid',
    '32バイト',
  );
}
for (const key of ['DB_CAPACITY_LIMIT_BYTES', 'STORAGE_CAPACITY_LIMIT_BYTES']) {
  const raw = value(key);
  const n = Number(raw);
  report(
    key,
    !raw ? 'optional' : /^\d+$/.test(raw) && Number.isSafeInteger(n) && n > 0 ? 'ok' : 'invalid',
    !raw ? '管理画面で未設定として表示' : '正の整数',
  );
}
console.log(JSON.stringify({ networkAccess: false, checks: results }, null, 2));
if (results.some((item) => ['missing', 'invalid'].includes(item.status))) process.exitCode = 1;
