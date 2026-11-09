import { fixupConfigRules } from '@eslint/compat';
import nextPlugin from '@next/eslint-plugin-next';
import nextBase from 'eslint-config-next';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  {
    ignores: [
      '.next/**',
      '.next-dev-admin/**',
      '.next-d1/**',
      '.next-demo/**',
      '.wrangler/**',
      '.open-next/**',
      'spikes/**',
      'node_modules/**',
      'next-env.d.ts',
      '.env*/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'Nicomaru/**',
      'Nicomaru-1/**',
    ],
  },
  // Next 16 exports flat configs, but the pinned Next 14 plugin's vitals config is legacy.
  // The base config already registers that plugin; apply only its vitals rules here.
  ...fixupConfigRules([
    ...nextBase,
    { rules: nextPlugin.configs['core-web-vitals'].rules },
    ...nextTypescript,
  ]),
];

export default config;
