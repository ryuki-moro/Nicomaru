import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

/** 実スクリプトを隔離した作業ディレクトリで起動し、DBアクセス前の拒否を確認する。 */
function launch(envFile: string, nodeEnv?: string, port = '3002') {
  const taskTmpRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(taskTmpRoot, 'nicomaru-admin-test-'));
  try {
    writeFileSync(join(directory, '.env.local'), envFile);
    const environment = { ...process.env };
    Object.assign(environment, { NODE_ENV: nodeEnv });
    return spawnSync(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/dev-admin.mts'), '--port', port],
      { cwd: directory, env: environment, encoding: 'utf8', timeout: 15000 },
    );
  } finally {
    const target = realpathSync(directory);
    if (!target.startsWith(`${taskTmpRoot}${sep}`)) throw new Error('一時ディレクトリの範囲外です');
    rmSync(target, { recursive: true, force: true });
  }
}

describe('開発用adminランチャー', () => {
  it('シェルでproduction指定されていればDB準備前に終了する', () => {
    const result = launch('NODE_ENV=development\n', 'production');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dev:admin は本番環境では起動できません');
  });
  it('環境ファイルでproduction指定されてもDB準備前に終了する', () => {
    const result = launch('NODE_ENV=production\n');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dev:admin は本番環境では起動できません');
  });
  it('不正なポートでDB準備を行わない', () => {
    const result = launch('', 'development', '-1');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ポート番号が正しくありません');
  });
});
