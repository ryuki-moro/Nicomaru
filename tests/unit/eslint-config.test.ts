import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../', import.meta.url)) });

describe('lint security and legacy Next rule compatibility', () => {
  it.each([
    [
      'src/__lint_probe.ts',
      'export const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;',
      'no-restricted-syntax',
      2,
    ],
    [
      'src/pages/_document.tsx',
      "import Document, { Head } from 'next/document'; export default class MyDocument extends Document { render() { return <html><Head /><Head /></html>; } }",
      '@next/next/no-duplicate-head',
      2,
    ],
    [
      'src/pages/example.tsx',
      'export default function Page() { return <link href="https://fonts.googleapis.com/css2?family=Roboto" rel="stylesheet" />; }',
      '@next/next/no-page-custom-font',
      1,
    ],
    [
      'src/__lint_probe.tsx',
      'export default function Page() { return <img src="foo.png" />; }',
      '@next/next/no-img-element',
      1,
    ],
  ])('detects violations in %s without crashing', async (filePath, code, ruleId, severity) => {
    const [result] = await eslint.lintText(code, { filePath });
    expect(result.messages.some((message) => message.fatal)).toBe(false);
    expect(result.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId, severity })]),
    );
  });

  it('allows the existing Service Role Key boundary module', async () => {
    const [result] = await eslint.lintText(
      'export const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;',
      {
        filePath: 'src/lib/supabase/admin.ts',
      },
    );
    expect(result.messages.filter((message) => message.ruleId === 'no-restricted-syntax')).toEqual(
      [],
    );
  });
});
