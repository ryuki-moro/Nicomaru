-- S03 CSVのkeyset取得と日時順の一覧を支える（Issue #45）。
-- 同時刻のログもUUIDで順序を固定し、各ページで全件を再ソートしない。
create index notification_logs_export_order_idx
  on notification_logs (created_at desc, id desc);
