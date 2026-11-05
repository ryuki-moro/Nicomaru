// Cloudflare本番D1に最初のsystem_adminを作るSQLを生成する。
// パスワードは画面・ログに出さず、Git対象外の .wrangler/bootstrap/ にだけ保存する。
//   node scripts/d1-bootstrap-admin.mjs --email you@example.com --name 山田太郎
//   npx wrangler d1 execute DB --remote --file .wrangler/bootstrap/admin.sql
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { hashPassword } from 'better-auth/crypto';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const email = arg('email')?.trim().toLowerCase();
const name = arg('name')?.trim();
if (!email || !/^[^\s@]+@[^\s@]+$/.test(email) || !name) {
  console.error('使い方: node scripts/d1-bootstrap-admin.mjs --email <メール> --name <氏名>');
  process.exit(1);
}
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const id = randomUUID();
const password = randomBytes(24).toString('base64url');
const hash = await hashPassword(password);
const now = Date.now();
const sql = [
  `INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (${quote(id)},${quote(name)},${quote(email)},1,${now},${now});`,
  `INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (${quote(randomUUID())},${quote(id)},'credential',${quote(id)},${quote(hash)},${now},${now});`,
  `INSERT INTO user_profiles (id,venue_id,role,status) VALUES (${quote(id)},NULL,'system_admin','active');`,
].join('\n');
await mkdir('.wrangler/bootstrap', { recursive: true });
await writeFile('.wrangler/bootstrap/admin.sql', sql + '\n', { flag: 'wx' });
await writeFile('.wrangler/bootstrap/admin-password.txt', password + '\n', {
  flag: 'wx',
  mode: 0o600,
});
console.log(
  '生成しました: .wrangler/bootstrap/admin.sql（適用後に削除）と admin-password.txt（初回ログイン後に削除）',
);
