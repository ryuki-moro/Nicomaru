import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export { usingD1, localD1 } from './mode';

interface Bindings {
  DB: D1Database;
  FILES: R2Bucket;
}
const local = globalThis as typeof globalThis & { nicomaruD1?: Promise<{ env: Bindings }> };

async function bindings(): Promise<Bindings> {
  if (process.env.NICOMARU_DB === 'd1') {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    return (await getCloudflareContext({ async: true })).env as unknown as Bindings;
  }
  const origin = new URL(process.env.APP_BASE_URL ?? '');
  if (
    process.env.NICOMARU_DB !== 'd1-local' ||
    process.env.NODE_ENV !== 'development' ||
    origin.origin !== 'http://127.0.0.1:3104'
  ) {
    throw new Error('D1ローカル検証専用の接続です');
  }
  // Workers向けの束ねにwranglerを含めないよう、指定子を変数にして実行時だけ読み込む。
  const wrangler = 'wrangler';
  local.nicomaruD1 ??= (
    import(/* webpackIgnore: true */ wrangler) as Promise<typeof import('wrangler')>
  ).then(({ getPlatformProxy }) =>
    getPlatformProxy<Bindings>({
      configPath: 'cloudflare/wrangler.jsonc',
      persist: { path: '.wrangler/app-local/v3' },
    }),
  );
  return (await local.nicomaruD1).env;
}

export async function localDB(): Promise<D1Database> {
  return (await bindings()).DB;
}

export async function localFiles(): Promise<R2Bucket> {
  return (await bindings()).FILES;
}
