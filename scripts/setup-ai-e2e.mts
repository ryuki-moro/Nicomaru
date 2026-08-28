/**
 * AIパイプラインの通し確認（ローカル）。
 *
 * 本番と同じマイグレーションを適用した検証用DBを作り、
 * ワーカーが拾えるジョブを1件積む。
 * 7-3 のプル型（ワーカーからのアウトバウンド接続のみ）が実際に成立するかを確かめるためのもので、
 * CI では使わない（Ollama が要るため）。
 *
 *   npx tsx scripts/setup-ai-e2e.mts
 *   AI_WORKER_DATABASE_URL=<出力の workerUrl> OLLAMA_MODEL=gemma3:12b npm run worker:ai
 */
import { Client } from 'pg';

import { createTestDatabase } from '../tests/db/pg-harness';

const url = await createTestDatabase('nicomaru_ai_e2e');
const db = new Client({ connectionString: url });
await db.connect();

// ワーカーが接続するロールにログイン権限を与える（本番は Supabase 側で設定する）。
// 権限はマイグレーションで付けた2関数の EXECUTE だけで、テーブルには触れない（7-3）。
await db.query(`alter role ai_worker with login password 'worker_local'`);

const venue = await db.query(`select id from venues where code = 'BRIDAL01'`);
const venueId = venue.rows[0].id as string;

const auth = await db.query(
  `insert into auth.users (email) values ('e2e-planner@example.test') returning id`);
const profile = await db.query(
  `insert into user_profiles (auth_user_id, venue_id, role, display_name, email)
   values ($1, $2, 'planner', '幸地', 'e2e-planner@example.test') returning id`,
  [auth.rows[0].id, venueId]);

const wcase = await db.query(
  `insert into wedding_cases (venue_id, primary_planner_id, case_code, wedding_date)
   values ($1, $2, 'BRIDAL01-2026-E2E1', current_date + 90) returning id`,
  [venueId, profile.rows[0].id]);

const jobs: { type: string; text: string }[] = [
  {
    type: 'classification',
    text: '披露宴でかけたい曲の希望があります。あと、料理のアレルギー対応もお願いしたいです。',
  },
  {
    type: 'task_extraction',
    text: '9/3 打ち合わせ。BGMは新婦が候補を出す。引き出物はカタログAで内定、'
      + '最終確定は次回。招待客リストは親族分がまだ未確定とのこと。',
  },
];

const ids: string[] = [];
for (const job of jobs) {
  const inserted = await db.query(
    `insert into ai_jobs (venue_id, case_id, job_type, input_ref, status)
     values ($1, $2, $3, $4::jsonb, 'queued') returning id`,
    [venueId, wcase.rows[0].id, job.type, JSON.stringify({ text: job.text, params: {} })],
  );
  ids.push(inserted.rows[0].id as string);
}

console.log(JSON.stringify({
  workerUrl: url.replace(/\/\/[^@]+@/, '//ai_worker:worker_local@'),
  adminUrl: url,
  jobIds: ids,
}, null, 2));

await db.end();
