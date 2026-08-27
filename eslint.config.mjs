import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // 6-3-5 / 12-2「Service Role 誤用防止」:
    // 使用範囲表を経由しない Service Role Key の参照を機械的に検出する。
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/lib/supabase/admin.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "MemberExpression[property.name='SUPABASE_SERVICE_ROLE_KEY']",
        message:
          'Service Role Key は src/lib/supabase/admin.ts の createSupabaseAdminClient() 経由でのみ使う'
          + '（基本設計書 6-3-5 表6-4 の使用範囲表を更新すること）',
      }],
    },
  },
];

export default config;
