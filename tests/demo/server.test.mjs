import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createDemoServer } from '../../scripts/demo-server.mjs';

const secret = 'SECRET_THAT_MUST_NEVER_BE_SERVED';
const fixtureFiles = {
  'index.html': '<!doctype html><html lang="ja"><body>にこまるデモ</body></html>',
  'styles.css': 'body { color: #333; }',
  'app.mjs': 'export const app = "demo";',
  'data.mjs': 'export const data = [];',
  'model.mjs': 'export const model = "local";',
};

async function removeFixture(directory) {
  const absolutePath = resolve(directory);
  if (dirname(absolutePath) !== resolve(tmpdir()) || !basename(absolutePath).startsWith('nicomaru-demo-server-')) {
    throw new Error('テスト用の一時ディレクトリ以外は削除できません。');
  }
  await rm(absolutePath, { recursive: true, force: true });
}

async function withServer(run) {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'nicomaru-demo-server-'));
  let server;
  try {
    const demoDir = join(fixtureDir, 'demo');
    await mkdir(demoDir);
    await Promise.all([
      ...Object.entries(fixtureFiles).map(([name, body]) => writeFile(join(demoDir, name), body)),
      writeFile(join(fixtureDir, '.env.local'), secret),
      writeFile(join(demoDir, '.env.local'), secret),
      writeFile(join(demoDir, 'unlisted.txt'), secret),
    ]);
    server = createDemoServer(demoDir);
    assert.equal(server.listening, false);
    await new Promise((resolveListening, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListening);
    });
    assert.equal(server.address().address, '127.0.0.1');
    await run(server.address().port, demoDir);
  } finally {
    if (server?.listening) {
      await new Promise((resolveClosed, reject) => {
        server.close((error) => error ? reject(error) : resolveClosed());
        server.closeAllConnections();
      });
    }
    await removeFixture(fixtureDir);
  }
}

function httpRequest(port, path, method = 'GET') {
  return new Promise((resolveResponse, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, method, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolveResponse({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

test('許可したデモファイルだけを正しい MIME と安全なヘッダーで配信する', async () => {
  await withServer(async (port) => {
    const files = [
      ['/', 'index.html', 'text/html; charset=utf-8'],
      ['/index.html', 'index.html', 'text/html; charset=utf-8'],
      ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
      ['/app.mjs', 'app.mjs', 'text/javascript; charset=utf-8'],
      ['/data.mjs', 'data.mjs', 'text/javascript; charset=utf-8'],
      ['/model.mjs', 'model.mjs', 'text/javascript; charset=utf-8'],
    ];
    for (const [path, filename, contentType] of files) {
      const response = await httpRequest(port, path);
      assert.equal(response.status, 200, path);
      assert.equal(response.body, fixtureFiles[filename], path);
      assert.equal(response.headers['content-type'], contentType, path);
      assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.body)), path);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.match(response.headers['cache-control'], /no-store/);
      const csp = response.headers['content-security-policy'];
      for (const policy of ["default-src 'self'", "script-src 'self'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'"]) {
        assert.ok(csp.split('; ').includes(policy), policy);
      }
      assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));
      assert.ok(!response.body.includes(secret));
    }
  });
});

test('HEAD は GET と同じメタデータで本文を返さない', async () => {
  await withServer(async (port) => {
    const get = await httpRequest(port, '/');
    const head = await httpRequest(port, '/', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal((await httpRequest(port, '/favicon.ico')).status, 204);
  });
});

test('環境設定・未許可・トラバーサル・エンコードされた生の経路をすべて拒否する', async () => {
  await withServer(async (port) => {
    // fetch は ../ を正規化するため、生の request.path を使って実際の攻撃経路を送る。
    const deniedPaths = [
      '/.env', '/.env.local', '/unlisted.txt', '/scripts/demo-server.mjs',
      '/../.env.local', '/demo/../.env.local', '/..\\.env.local',
      '/%2e%2e/.env.local', '/%2E%2E%2F.env.local', '/%252e%252e%252f.env.local',
      '/%2eenv.local', '/%61pp.mjs', '/app.mjs%00', '//app.mjs',
      '/app.mjs/../.env.local', '/app.mjs%2f../.env.local',
    ];
    for (const path of deniedPaths) {
      const response = await httpRequest(port, path);
      assert.equal(response.status, 404, path);
      assert.equal(response.body, 'Not Found\n', path);
      assert.ok(!response.body.includes(secret), path);
    }
    const head = await httpRequest(port, '/.env.local', 'HEAD');
    assert.equal(head.status, 404);
    assert.equal(head.body, '');
  });
});

test('POST などの書き込みリクエストを拒否する', async () => {
  await withServer(async (port) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await httpRequest(port, '/', method);
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.allow, 'GET, HEAD');
      assert.equal(response.body, 'Method Not Allowed\n');
      assert.ok(!response.body.includes(secret));
    }
  });
});

test('欠けたファイルや許可名のディレクトリから内部パスを漏らさない', async () => {
  await withServer(async (port, demoDir) => {
    await rm(join(demoDir, 'app.mjs'));
    await mkdir(join(demoDir, 'app.mjs'));
    await writeFile(join(demoDir, 'app.mjs', '.env.local'), secret);
    const directory = await httpRequest(port, '/app.mjs');
    assert.equal(directory.status, 404);
    assert.equal(directory.body, 'Not Found\n');
    await rm(join(demoDir, 'styles.css'));
    const missing = await httpRequest(port, '/styles.css');
    assert.equal(missing.status, 404);
    assert.equal(missing.body, 'Not Found\n');
    assert.ok(!missing.body.includes(demoDir));
  });
});

test('許可ファイル名の symlink を通じても秘密ファイルを配信しない', async (context) => {
  await withServer(async (port, demoDir) => {
    await rm(join(demoDir, 'model.mjs'));
    try {
      await symlink(join(dirname(demoDir), '.env.local'), join(demoDir, 'model.mjs'), 'file');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        context.skip('この Windows 環境ではテスト用の symlink を作成できません。');
        return;
      }
      throw error;
    }
    const response = await httpRequest(port, '/model.mjs');
    assert.equal(response.status, 404);
    assert.equal(response.body, 'Not Found\n');
    assert.ok(!response.body.includes(secret));
  });
});
