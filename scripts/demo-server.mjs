import { createServer } from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRootDir = fileURLToPath(new URL('../demo/', import.meta.url));
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/data.mjs', ['data.mjs', 'text/javascript; charset=utf-8']],
  ['/model.mjs', ['model.mjs', 'text/javascript; charset=utf-8']],
]);

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store, max-age=0',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
};

function send(
  request,
  response,
  status,
  body,
  contentType = 'text/plain; charset=utf-8',
  headers = {},
) {
  response.writeHead(status, {
    ...securityHeaders,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

/** 認証情報やアプリ本体へアクセスしない、デモ専用の静的サーバー。 */
export function createDemoServer(rootDir = defaultRootDir) {
  const staticRoot = resolve(rootDir);

  return createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(request, response, 405, 'Method Not Allowed\n', undefined, { Allow: 'GET, HEAD' });
      return;
    }

    // URL の正規化やデコードをせず、許可した生のパスだけに一致させる。
    const pathname = (request.url ?? '').split('?')[0];
    if (pathname === '/favicon.ico') {
      response.writeHead(204, securityHeaders);
      response.end();
      return;
    }

    const route = routes.get(pathname);
    if (!route) {
      send(request, response, 404, 'Not Found\n');
      return;
    }

    const [filename, contentType] = route;
    const filePath = join(staticRoot, filename);
    try {
      // 配信対象に秘密ファイルへの symlink を置いても配信しない。
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        send(request, response, 404, 'Not Found\n');
        return;
      }
      const body = await readFile(filePath);
      send(request, response, 200, body, contentType);
    } catch (error) {
      const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
      send(
        request,
        response,
        missing ? 404 : 500,
        missing ? 'Not Found\n' : 'Internal Server Error\n',
      );
    }
  });
}

function parsePort(args) {
  if (args.length === 0) return 3100;
  let rawPort;
  if (args.length === 2 && args[0] === '--port') rawPort = args[1];
  if (args.length === 1 && args[0].startsWith('--port=')) rawPort = args[0].slice('--port='.length);
  if (!rawPort || !/^\d+$/.test(rawPort)) {
    throw new Error('使い方: npm run demo -- [--port 3100]');
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('ポート番号は 1024〜65535 を指定してください。');
  }
  return port;
}

function startCli() {
  let port;
  try {
    port = parsePort(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const server = createDemoServer();
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `ポート ${port} は使用中です。npm run demo -- --port 3101 などで別のポートを指定してください。`,
      );
    } else {
      console.error(`デモを起動できませんでした: ${error.message}`);
    }
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`ログイン不要の「にこまる」デモ: http://127.0.0.1:${port}`);
    console.log('終了するには Ctrl + C を押してください。');
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      console.log('デモを終了しました。');
    });
    server.closeAllConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

// テストなどから import した場合は待ち受けを開始しない。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startCli();
}
