import { getPlatformProxy } from 'wrangler';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export const usingD1 = () => process.env.NICOMARU_DB === 'd1-local';
const local = globalThis as typeof globalThis & {
  nicomaruD1?: Promise<Awaited<ReturnType<typeof getPlatformProxy>>>;
};

export async function localDB(): Promise<D1Database> {
  const origin = new URL(process.env.APP_BASE_URL ?? '');
  if (
    !usingD1() ||
    process.env.NODE_ENV !== 'development' ||
    origin.origin !== 'http://127.0.0.1:3104'
  ) {
    throw new Error('D1ローカル検証専用の接続です');
  }
  local.nicomaruD1 ??= getPlatformProxy({
    configPath: 'cloudflare/wrangler.jsonc',
    persist: { path: '.wrangler/app-local/v3' },
  });
  return ((await local.nicomaruD1).env as { DB: D1Database }).DB;
}

export async function localFiles(): Promise<R2Bucket> {
  await localDB();
  return ((await local.nicomaruD1!).env as { FILES: R2Bucket }).FILES;
}
