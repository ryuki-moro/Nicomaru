import { readdirSync } from 'node:fs';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { middleware } from '@/middleware';

afterEach(() => vi.unstubAllEnvs());

describe('Cloudflare本番のD1（NICOMARU_DB=d1）', () => {
  beforeEach(() => {
    vi.stubEnv('NICOMARU_DB', 'd1');
    vi.stubEnv('APP_BASE_URL', 'https://nicomaru.example.test');
  });

  it('ループバック以外のHostでも移行済みの画面へ進める', async () => {
    const response = await middleware(new NextRequest('https://nicomaru.example.test/cases'));
    expect(response.status).toBe(200);
  });

  it('ローカル受信箱は存在しない扱いにする', async () => {
    for (const path of ['/dev/mailbox', '/api/dev/mailbox']) {
      const response = await middleware(new NextRequest(`https://nicomaru.example.test${path}`));
      expect(response.status).toBe(404);
    }
  });

  it('未移行の機能は503で遮断し、対象外として扱う', async () => {
    // /venues は Wave2 で D1 化したため、未移行の例は /meetings (打ち合わせ) に差し替える
    const response = await middleware(new NextRequest('https://nicomaru.example.test/meetings'));
    expect(response.status).toBe(503);
  });

  it('src/app にある全ての画面・APIを対象外として遮断しない', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const paths = readdirSync('src/app', { recursive: true, encoding: 'utf8' })
      .filter((f) => /(^|[\\/])(route\.ts|page\.tsx)$/.test(f))
      .map(
        (f) =>
          '/' +
          f
            .replace(/\\/g, '/')
            .replace(/(^|\/)(route\.ts|page\.tsx)$/, '')
            .split('/')
            .filter((s) => s && !/^\(.+\)$/.test(s))
            .map((s) => (/^\[.+\]$/.test(s) ? id : s))
            .join('/'),
      );
    const blocked = [];
    for (const path of paths) {
      const response = await middleware(new NextRequest(`https://nicomaru.example.test${path}`));
      if (response.status === 503) blocked.push(path);
    }
    expect(paths.length).toBeGreaterThan(50);
    expect(blocked).toEqual([]);
  });

  it('Wave2で移行した管理系画面へ進める', async () => {
    for (const path of ['/venues', '/templates', '/plan-types', '/system']) {
      const response = await middleware(new NextRequest(`https://nicomaru.example.test${path}`));
      expect(response.status).toBe(200);
    }
  });

  it('APP_BASE_URL未設定では処理しない', async () => {
    vi.stubEnv('APP_BASE_URL', undefined);
    const response = await middleware(new NextRequest('https://nicomaru.example.test/cases'));
    expect(response.status).toBe(500);
  });

  it('LINE連携のAPIは410を返す', async () => {
    const response = await middleware(
      new NextRequest('https://nicomaru.example.test/api/line/webhook'),
    );
    expect(response.status).toBe(410);
  });
});

describe('ローカル検証のD1（NICOMARU_DB=d1-local）', () => {
  it('ループバック以外のHostを拒否する', async () => {
    vi.stubEnv('NICOMARU_DB', 'd1-local');
    vi.stubEnv('APP_BASE_URL', 'http://127.0.0.1:3104');
    const response = await middleware(new NextRequest('https://nicomaru.example.test/cases'));
    expect(response.status).toBe(403);
  });
  it.each([
    ['http://127.0.0.1:3104', 200],
    ['http://127.0.0.1:3105', 200],
    ['http://127.0.0.1:3000', 403],
  ])('待受先 %s を dev:d1・demo のものだけに限る', async (origin, status) => {
    vi.stubEnv('NICOMARU_DB', 'd1-local');
    vi.stubEnv('APP_BASE_URL', origin);
    const response = await middleware(
      new NextRequest(`${origin}/cases`, { headers: { host: new URL(origin).host } }),
    );
    expect(response.status).toBe(status);
  });

  it('APP_BASE_URLと異なるポートへの要求を拒否する', async () => {
    vi.stubEnv('NICOMARU_DB', 'd1-local');
    vi.stubEnv('APP_BASE_URL', 'http://127.0.0.1:3105');
    const response = await middleware(
      new NextRequest('http://127.0.0.1:3104/cases', { headers: { host: '127.0.0.1:3104' } }),
    );
    expect(response.status).toBe(403);
  });
});
