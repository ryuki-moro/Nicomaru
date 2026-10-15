import { mkdir, writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';
import { TestDb } from '../../tests/db/harness';

const db = await TestDb.create({ seed: false });
try {
  const tables = (
    await db.query(`select c.relname as name, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' order by c.relname`)
  ).rows;
  const columns = (
    await db.query(`select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_schema='public'
    order by table_name,ordinal_position`)
  ).rows;
  const constraints = (
    await db.query(`select t.relname as table_name, c.conname as name, c.contype as type,
    pg_get_constraintdef(c.oid) as definition from pg_constraint c
    join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' order by t.relname,c.conname`)
  ).rows;
  const policies = (
    await db.query(`select tablename as table_name, policyname, roles, cmd, qual, with_check
    from pg_policies where schemaname='public' order by tablename,policyname`)
  ).rows;
  const functions = (
    await db.query(`select p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments,
    pg_get_function_result(p.oid) as result, p.prosecdef as security_definer
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f'
    and not exists(select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
    order by p.proname`)
  ).rows;
  await mkdir('docs/詳細設計', { recursive: true });
  await writeFile(
    'docs/詳細設計/schema.json',
    await format(
      JSON.stringify(
        {
          source:
            'supabase/migrations/*.sql applied to isolated PGlite; catalog only, no application data',
          tables,
          columns,
          constraints,
          policies,
          functions,
        },
        null,
        2,
      ),
      { ...((await resolveConfig('docs/詳細設計/schema.json')) ?? {}), parser: 'json' },
    ),
  );
  console.log(
    JSON.stringify({
      tables: tables.length,
      columns: columns.length,
      constraints: constraints.length,
      policies: policies.length,
      functions: functions.length,
    }),
  );
} finally {
  await db.close();
}
