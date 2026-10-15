import { fixupPluginRules } from '@eslint/compat';
import nextPlugin from '@next/eslint-plugin-next';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

// eslint-config-next 16 ships flat configs, but @next/eslint-plugin-next stays pinned to the
// secure 14.2.35 via package.json overrides (docs/依存関係の脆弱性対応.md). That plugin uses
// legacy rule APIs and only has eslintrc-style configs (`plugins: ['@next/next']`), so:
// - wrap it with fixupPluginRules so its rules run on ESLint 9,
// - drop the eslintrc-style core-web-vitals entry and apply its rules in flat form instead.
const legacyNextPlugin = fixupPluginRules(nextPlugin);

const nextConfigs = [...nextCoreWebVitals, ...nextTypescript]
  .filter((entry) => !Array.isArray(entry.plugins))
  .map((entry) =>
    entry.plugins?.['@next/next']
      ? {
          ...entry,
          plugins: { ...entry.plugins, '@next/next': legacyNextPlugin },
          rules: { ...entry.rules, ...nextPlugin.configs['core-web-vitals'].rules },
        }
      : entry,
  );

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      '.env*/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  ...nextConfigs,
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
