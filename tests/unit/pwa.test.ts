import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';

import { config } from '@/middleware';

describe('PWAは機微データをオフライン保存しない', () => {
  it('manifestのアイコンに実際の192/512px PNGがあり、maskableとAppleアイコンも揃う', () => {
    const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
    expect(manifest).toMatchObject({ id: '/', scope: '/', start_url: '/', display: 'standalone' });
    for (const size of [192, 512]) {
      const icon = manifest.icons.find(
        (entry: { sizes: string; purpose: string }) =>
          entry.sizes === size + 'x' + size && entry.purpose === 'any',
      );
      expect(icon).toBeDefined();
      const png = readFileSync('public' + icon.src);
      expect(png.toString('hex', 0, 8)).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable')).toBe(
      true,
    );
    const apple = readFileSync('public/icons/apple-touch-icon.png');
    expect(apple.readUInt32BE(16)).toBe(180);
  });

  it('SWはinstall/activateだけ登録し、fetch横取り・キャッシュ・自動送信をしない', async () => {
    const listeners = new Map<
      string,
      (event: { waitUntil: (promise: Promise<void>) => void }) => void
    >();
    const claim = vi.fn().mockResolvedValue(undefined);
    const skipWaiting = vi.fn();
    runInNewContext(readFileSync('public/sw.js', 'utf8'), {
      self: {
        addEventListener: (
          type: string,
          callback: (event: { waitUntil: (promise: Promise<void>) => void }) => void,
        ) => listeners.set(type, callback),
        skipWaiting,
        clients: { claim },
      },
    });
    expect([...listeners.keys()].sort()).toEqual(['activate', 'install']);
    listeners.get('install')!({ waitUntil: vi.fn() });
    let activation: Promise<void> | undefined;
    listeners.get('activate')!({
      waitUntil: (promise) => {
        activation = promise;
      },
    });
    await activation;
    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
  });

  it('SW/manifest/iconsは認証middlewareの対象外、アプリ/APIは対象内', () => {
    for (const url of [
      '/sw.js',
      '/manifest.webmanifest',
      '/icons/icon-192.png',
      '/icons/icon.svg',
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
    }
    for (const url of ['/mypage', '/api/venues', '/register/private-token']) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    }
  });
});
