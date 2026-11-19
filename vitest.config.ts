import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 環境変数を扱うユニットテストはファイルごとに隔離して直列で実行する
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
