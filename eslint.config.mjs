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
