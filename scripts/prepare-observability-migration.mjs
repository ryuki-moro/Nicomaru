import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// SQL Editor向け。移行の正本はsupabase/migrations。秘密値・対象データは含めない。
const files = [
  '20261009000100_usage_snapshots.sql',
  '20261009000200_system_monitoring.sql',
  '20261009000300_audit_coverage.sql',
  '20261009000400_audit_retention.sql',
  '20261009000600_register_observability_jobs.sql',
  '20261009000700_protect_auth_audit_events.sql',
];
const statements = files.map((file) => readFileSync(resolve('supabase/migrations', file), 'utf8'));
const header = `-- 対象: 学校用の既存Supabase。DB所有者として実行。
-- アプリの新機能の定義だけを追加。削除RPC/通知RPC/cron登録関数は呼び出さない。
-- 一部だけ適用済みならここで止め、migration個別の適用履歴を確認する。
begin;
select pg_advisory_xact_lock(60100999);
do $$ begin
  if to_regclass('public.usage_snapshots') is not null
     or to_regclass('public.system_alerts') is not null then
    raise exception 'New monitoring tables already exist; inspect migration history first';
  end if;
  if to_regclass('public.audit_logs') is null or to_regclass('public.batch_runs') is null then
    raise exception 'Base schema is missing; select the intended project';
  end if;
end $$;
`;
const history = `
-- Supabase CLIと手動適用の履歴を一致させる。既存の履歴・業務データは変更しない。
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key, statements text[], name text
);
insert into supabase_migrations.schema_migrations(version, name) values
${files.map((file) => `('${file.slice(0, 14)}', '${file.slice(15, -4)}')`).join(',\n')}
on conflict (version) do nothing;
notify pgrst, 'reload schema';
commit;

-- 定義の存在確認のみ（実データ削除や通知は実行しない）。
select to_regclass('public.usage_snapshots') as usage_table,
       to_regclass('public.system_alerts') as alerts_table,
       to_regprocedure('public.record_auth_failure(text,text)') as auth_failure_rpc;
`;
mkdirSync('.env.venue-preview', { recursive: true });
writeFileSync(
  '.env.venue-preview/追加migration適用.sql',
  header + statements.join('\n\n') + history,
);
console.log(
  JSON.stringify({
    migrations: files.length,
    output: '.env.venue-preview/追加migration適用.sql',
    databaseAccess: false,
  }),
);
