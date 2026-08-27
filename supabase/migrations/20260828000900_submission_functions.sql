-- BridalHub / にこまる — 提出フローで不足していた権限の補完
--
-- 実装時に判明した、付録A のポリシーだけでは 6-7 の中心導線が成立しない箇所を塞ぐ。
-- いずれも「couple に広い update を開く」のではなく、必要な1操作だけを
-- security definer 関数へ切り出す方式に揃える（submit_task() と同じ考え方）。
--
--   (1) 不備指摘（needs_fix）からの再提出ができない
--       task_submissions_update_couple の USING は review_status in ('draft','submitted') に
--       限られるため、couple は needs_fix／confirmed の行の is_latest を落とせない。
--       一方 6-7 は「needs_fix／confirmed からの再提出は新規行として扱い is_latest を付け替える」
--       と規定しており、部分ユニーク task_submissions_latest_uk があるため
--       旧行を降格できないと新規 insert が 23505 で失敗する。
--       → 提出 → 不備あり → 再提出 という Phase 1 の中心導線が塞がる。
--
--   (2) communication_logs へ書けない
--       付録A は select ポリシーしか持たないため、6-7 の「3・4・5 の各時点で自動記録」が
--       どのロールからも insert できない。audit_logs と同じく関数経由に統一する。
--
--   (3) 置き換えられた添付ファイルを消せない
--       6-7 は上書き時に旧ファイルの実体とメタを削除すると規定するが、
--       storage_files に delete ポリシーが無い（＝全拒否）。

-- ============================================================ 1. 再提出の前段
-- 最新提出を「最新でない」状態にする。再提出（新規行 insert）の直前にだけ使う。
-- 降格できるのは review_status が needs_fix／confirmed の行に限る。
-- draft／submitted は上書き更新が正しい経路であり（6-7）、ここを通す必要が無い。
create or replace function demote_latest_submission(p_case_task_id uuid) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case uuid;
  v_role text;
  v_id   uuid;
begin
  select ct.case_id into v_case from case_tasks ct where ct.id = p_case_task_id;
  select u.role    into v_role from current_app_user() u;

  if v_case is null
     or v_case not in (select accessible_case_ids())
     or not case_is_visible(v_case) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- 提出は couple の操作。planner の確認は task_submissions_review_planner が担う。
  if v_role <> 'couple' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- 同一案件のパートナーが提出した行でも降格できる。
  -- 新郎新婦は1つの案件を共有しており（2-3）、どちらが出し直しても同じ宿題を指すため。
  update task_submissions
     set is_latest = false
   where case_task_id = p_case_task_id
     and is_latest
     and review_status in ('needs_fix', 'confirmed')
  returning id into v_id;

  return v_id;
end
$$;

grant execute on function demote_latest_submission(uuid) to authenticated;

-- ========================================================= 2. 連絡履歴の自動記録
-- created_by を引数で受け取らず関数内で解決することで、実行者の偽装を防ぐ（log_audit と同じ）。
-- 記録できるのは自分が触れてよい案件に限る。
create or replace function log_communication(
  p_case_id   uuid,
  p_channel   text,
  p_direction text,
  p_source    text,
  p_summary   text
) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_case_id is null
     or p_case_id not in (select accessible_case_ids())
     or not case_is_visible(p_case_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into communication_logs (case_id, channel, direction, source, summary,
                                  occurred_at, created_by)
  values (p_case_id, p_channel, p_direction, p_source, p_summary,
          now(), (select u.id from current_app_user() u));
end
$$;

grant execute on function log_communication(uuid, text, text, text, text) to authenticated;

-- ================================================= 3. 孤児ファイルの削除を許可する
-- 上書きで参照されなくなった添付は、無料枠の容量を圧迫し
-- 案件単位の自動削除（6-11）からも漏れるため、その場で消せるようにする（6-7）。
create policy storage_files_delete on storage_files
  for delete using (
    case_id in (select accessible_case_ids()) and case_is_visible(case_id)
    and (uploaded_by = (select u.id from current_app_user() u)
         or exists (select 1 from current_app_user() u
                     where u.role in ('planner', 'admin', 'system_admin')))
  );

-- ============================================ 4. Supabase Storage 側のアクセス制御
-- 提出ファイルは private bucket 'case-files' に置き、DB の権限判定と同等の範囲に制限する
-- （6-3-3 の最終項目／6-11）。object_path の先頭2階層を venue_id/case_id とし、
-- case_id 部分を accessible_case_ids() と突き合わせる（表5-16 のパス設計）。
--
-- storage スキーマは Supabase 側が提供するもので、ローカルの検証用 PostgreSQL には存在しない。
-- マイグレーションを共通に保つため、存在するときだけ適用する。
do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'storage スキーマが無いため Storage ポリシーの適用をスキップします';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('case-files', 'case-files', false)
  on conflict (id) do update set public = false;

  execute $ddl$
    drop policy if exists case_files_select on storage.objects;
    create policy case_files_select on storage.objects
      for select to authenticated
      using (
        bucket_id = 'case-files'
        and (storage.foldername(name))[2]::uuid in (select accessible_case_ids())
      );

    drop policy if exists case_files_insert on storage.objects;
    create policy case_files_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'case-files'
        and (storage.foldername(name))[2]::uuid in (select accessible_case_ids())
      );

    drop policy if exists case_files_delete on storage.objects;
    create policy case_files_delete on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'case-files'
        and (storage.foldername(name))[2]::uuid in (select accessible_case_ids())
      );
  $ddl$;
end
$$;
