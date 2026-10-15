/** Auth の変更より前に、URLから判別できる同一プロジェクトの組だけを許す。 */
export function assertDemoProjectTargets(supabaseUrl: string, databaseUrl: string): void {
  let api: URL;
  let db: URL;
  try {
    api = new URL(supabaseUrl);
    db = new URL(databaseUrl);
  } catch {
    throw new Error('Supabase URL と DEMO_DATABASE_URL の形式を確認してください');
  }
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  // 接続文字列の query で host/user/port が上書きされると、下の同一性確認を迂回する。
  const validQuery = [...db.searchParams].every(
    ([key, setting]) =>
      key === 'sslmode' &&
      ['disable', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify'].includes(setting),
  );
  if (
    !['http:', 'https:'].includes(api.protocol) ||
    api.username ||
    api.password ||
    api.pathname !== '/' ||
    api.search ||
    api.hash ||
    !['postgres:', 'postgresql:'].includes(db.protocol) ||
    db.pathname !== '/postgres' ||
    db.hash ||
    !validQuery
  ) {
    throw new Error('同一性を確認できる標準の Supabase 接続URLを指定してください');
  }
  if (loopback.has(api.hostname) && loopback.has(db.hostname)) {
    if (api.port === '54321' && db.port === '54322') return;
    throw new Error('ローカルの同一性確認には Supabase 54321 / DB 54322 の組が必要です');
  }

  const apiRef = api.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/)?.[1];
  const directRef = db.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/)?.[1];
  const poolRef = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(db.hostname)
    ? db.username.match(/^postgres\.([a-z0-9]{20})$/)?.[1]
    : undefined;
  if (api.protocol !== 'https:' || api.port || !apiRef || apiRef !== (directRef ?? poolRef)) {
    // 値は資格情報を含み得るので表示しない。独自ドメインは推測せず停止する。
    throw new Error(
      'Supabase と DB の project-ref が一致する公式URLを指定してください（Auth は変更していません）',
    );
  }
}

/** ローカル投入後のリスク再計算を、別の外部アプリへ送らない。 */
export function assertDemoAppTarget(appBaseUrl: string, remote: boolean): void {
  let app: URL;
  try {
    app = new URL(appBaseUrl);
  } catch {
    throw new Error('APP_BASE_URL の形式を確認してください');
  }
  if (
    !['http:', 'https:'].includes(app.protocol) ||
    app.username ||
    app.password ||
    app.pathname !== '/' ||
    app.search ||
    app.hash
  ) {
    throw new Error('APP_BASE_URL にはアプリの http(s) Origin を指定してください');
  }
  if (!remote && !['localhost', '127.0.0.1', '[::1]'].includes(app.hostname)) {
    throw new Error(
      'ローカル投入では APP_BASE_URL も loopback にしてください（外部アプリには送信しません）',
    );
  }
}
