import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // PGlite は1インスタンスあたり数十MBのWASMを確保するため、DBテストは直列で回す
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
