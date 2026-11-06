-- AI補助（基本設計 7-1〜7-6）。Supabase版の ai_jobs／ai_prompt_templates／ai_worker_heartbeats をD1へ移す。
-- ワーカーはDBへ直接つながず、/api/internal/ai-worker（共有トークン）だけを通す。
CREATE TABLE ai_prompt_templates (
  id TEXT PRIMARY KEY, venue_id TEXT REFERENCES venues(id),
  job_type TEXT NOT NULL CHECK(job_type IN ('classification','draft','defect_check','task_extraction','faq_answer','reschedule_plan','handover_summary','template_draft','translation')),
  name TEXT NOT NULL, model_name TEXT, prompt_text TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(venue_id, job_type, version)
);
CREATE TABLE ai_jobs (
  id TEXT PRIMARY KEY, venue_id TEXT NOT NULL REFERENCES venues(id),
  case_id TEXT NOT NULL REFERENCES wedding_cases(id), related_task_id TEXT REFERENCES case_tasks(id),
  job_type TEXT NOT NULL CHECK(job_type IN ('classification','draft','defect_check','task_extraction','faq_answer','reschedule_plan','handover_summary','template_draft','translation')),
  input_ref TEXT NOT NULL, output TEXT, reviewed_output TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','done','failed','confirmed','discarded')),
  model_name TEXT, prompt_template_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, finished_at TEXT, locked_by TEXT, locked_at TEXT,
  confirmed_by TEXT REFERENCES user_profiles(id), confirmed_at TEXT, error_message TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX ai_jobs_queue ON ai_jobs(status, created_at);
CREATE INDEX ai_jobs_task ON ai_jobs(related_task_id, job_type, created_at);
CREATE TABLE ai_worker_heartbeats (
  worker_name TEXT PRIMARY KEY, model_name TEXT, last_seen_at TEXT NOT NULL
);
-- プロンプトは supabase/migrations/20260828001700_ai_prompts_seed.sql と同じ文面。
INSERT INTO ai_prompt_templates (id, venue_id, job_type, name, prompt_text, version, active) VALUES
('00000000-0000-4000-a000-000000000001', NULL, 'classification', '自由記述のカテゴリ分類 v1',
'あなたは結婚式場のプランナーを補助するアシスタントです。
新郎新婦から届いた自由記述を読み、内容が該当するカテゴリを選んでください。

出力は次のJSONだけを返してください。説明文は書かないでください。
{"labels": ["カテゴリ名", ...], "confidence": 0.0〜1.0の数値}

labels に使えるカテゴリ名は次の10個だけです。これ以外の語を作らないでください。
日程 / 費用 / 衣装 / 料理・飲物 / 装花・装飾 / 写真・映像 / 招待客・席次 / 進行・演出 / 支払い・手続き / その他

判断がつかない場合は "その他" を選び、confidence を低くしてください。
複数の話題が含まれる場合は該当するものをすべて挙げてください。',
 1, 1),

('00000000-0000-4000-a000-000000000002', NULL, 'draft', '通知・コメント文面の下書き v1',
'あなたは結婚式場のプランナーを補助するアシスタントです。
新郎新婦へお送りする文面の下書きを作ってください。最終的な確認と送信はプランナーが行います。

出力は次のJSONだけを返してください。説明文は書かないでください。
{"text": "文面", "cautions": ["プランナーに確認してほしい点", ...]}

文面の決まりごと:
・宛名から書き始め、担当プランナーの名前で締めてください。
・「まだ提出されていません」「至急」「必ず」「遅れています」など、
  できていないことを強調する言い方や、決めつけた催促はしないでください。
・感嘆符は使わないでください。
・「ご準備がお済みでしたら」「ご都合がつかない場合はご相談ください」
  「期限の調整も可能です」のように、選択肢と相談先を併せて示してください。
・全角140字以内に収めてください。

事実として確認できない点を文面に書いた場合は、必ず cautions に挙げてください。',
 1, 1),

('00000000-0000-4000-a000-000000000003', NULL, 'defect_check', '提出物の表記ゆれ・敬称チェック v1',
'あなたは結婚式場のプランナーを補助するアシスタントです。
招待客リストを読み、「表記ゆれ」と「敬称の誤り」の**疑い**だけを挙げてください。

出力は次のJSONだけを返してください。説明文は書かないでください。
{"findings": [{"row": 行番号, "column": "列名", "type": "inconsistent_notation" または "honorific",
               "detail": "気づいた点", "confidence": 0.0〜1.0の数値}]}

・row はヘッダー行を除いた1始まりの行番号です。
・未入力・重複・桁数の誤りは別の仕組みで検査済みなので、ここでは挙げないでください。
・表記ゆれの例: 同じ人物や地名が「渡辺」と「渡邊」、「1-2-3」と「一丁目二番三号」のように
  書き分けられている。
・敬称の例: 一部の行にだけ「様」が付いている、「御中」と「様」が混ざっている。
・確信が持てないものは confidence を低くしてください。無理に挙げる必要はありません。
・疑いが無ければ findings を空配列にしてください。',
 1, 1),

('00000000-0000-4000-a000-000000000004', NULL, 'task_extraction', '打ち合わせ記録からの宿題起票案 v1',
'あなたは結婚式場のプランナーを補助するアシスタントです。
打ち合わせのメモを読み、新郎新婦にお願いする「宿題」の案を挙げてください。
登録するかどうかはプランナーが決めます。あなたは案を出すだけです。

出力は次のJSONだけを返してください。説明文は書かないでください。
{"tasks": [{"title": "宿題名", "description": "説明", "due_hint": "期限の目安"}]}

・title は100字以内、新郎新婦が読んで何をすればよいか分かる言い方にしてください。
・description には、メモのどの部分から起こした案かが分かるように書いてください。
・due_hint は「挙式2か月前ごろ」「次回の打ち合わせまで」のような目安で構いません。
  日付を断定しないでください。期限はプランナーが決めます。
・メモに書かれていないことを推測で足さないでください。
・宿題にあたる内容が無ければ tasks を空配列にしてください。',
 1, 1);
