import { fixupConfigRules } from '@eslint/compat';
import nextConfig from 'eslint-config-next';
import nextTypescript from 'eslint-config-next/typescript';
import nextPlugin from '@next/eslint-plugin-next';

const config = [
  {
    ignores: [
      '.next/**',
      '.next-dev-admin/**',
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
  // 固定済みNextプラグインの旧APIとルールを保ち、legacyのplugins配列だけを持ち込まない。
  ...fixupConfigRules([
    ...nextConfig,
    { rules: nextPlugin.configs['core-web-vitals'].rules },
    ...nextTypescript,
  ]),
  {
    // 6-3-5 / 12-2「Service Role 誤用防止」:
    // 使用範囲表を経由しない Service Role Key の参照を機械的に検出する。
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/lib/supabase/admin.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='SUPABASE_SERVICE_ROLE_KEY']",
          message:
            'Service Role Key は src/lib/supabase/admin.ts の createSupabaseAdminClient() 経由でのみ使う' +
            '（基本設計書 6-3-5 表6-4 の使用範囲表を更新すること）',
        },
      ],
    },
  },
];

export default config;
