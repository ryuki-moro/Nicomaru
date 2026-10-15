import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tests/unit/**/*.test.ts'],
      coverage: {
        enabled: true,
        provider: 'v8',
        reporter: ['text', 'json-summary', 'json', 'html'],
        include: [
          'src/lib/services/risk.ts',
          'src/lib/services/schedule.ts',
          'src/lib/auth/session.ts',
        ],
        thresholds: { perFile: true, branches: 100 },
      },
    },
  }),
);
