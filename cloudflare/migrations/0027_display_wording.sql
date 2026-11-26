-- 画面に出る初期データの「宿題」を「やること」に言い換える（#264）。
-- 0010・0012・0023・0025 の初期データは編集せず、ここで UPDATE する（適用済みの migration は書き換えない。#266）。
-- id・condition_key・job_type・version などの識別子とコード値は変えない。
-- どの UPDATE も置き換え後の文言を固定値で入れるか REPLACE するだけなので、何度流しても結果は同じ。

-- 遅れの理由（ダッシュボード・案件詳細・案件一覧に出る）。システム共通ルールだけを直す。
UPDATE risk_rules SET name = '挙式30日以内で重要なやることが未提出', description = '挙式日が近く、重要なやることが未提出です'
  WHERE id = '20000000-0000-4000-8000-000000000001' AND venue_id IS NULL;
UPDATE risk_rules SET name = '期限を過ぎた未提出のやることがある', description = '提出期限を過ぎたやることがあります'
  WHERE id = '20000000-0000-4000-8000-000000000002' AND venue_id IS NULL;
UPDATE risk_rules SET name = '不備ありのやることがある', description = '再提出をお願いしているやることがあります'
  WHERE id = '20000000-0000-4000-8000-000000000004' AND venue_id IS NULL;

-- 算出済みの理由は文言の写しを JSON で持つため、再計算までの間も新しい言い方で出るよう同じ置き換えをする。
UPDATE risk_score_snapshots SET reasons =
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(reasons,
    '挙式30日以内で重要宿題が未提出', '挙式30日以内で重要なやることが未提出'),
    '挙式日が近く、重要な宿題が未提出です', '挙式日が近く、重要なやることが未提出です'),
    '期限超過の未提出宿題がある', '期限を過ぎた未提出のやることがある'),
    '提出期限を過ぎた宿題があります', '提出期限を過ぎたやることがあります'),
    '不備ありの宿題がある', '不備ありのやることがある'),
    '再提出をお願いしている宿題があります', '再提出をお願いしているやることがあります')
  WHERE reasons LIKE '%宿題%';

-- AI への指示文。AI が書く要約・説明文（引継ぎサマリー・期限見直しの説明など）がこの言葉に引っ張られて画面に出るため合わせる。
UPDATE ai_prompt_templates SET
  name = REPLACE(name, '宿題', 'やること'),
  prompt_text = REPLACE(REPLACE(prompt_text, '宿題名', 'やることの名前'), '宿題', 'やること')
  WHERE venue_id IS NULL AND (name LIKE '%宿題%' OR prompt_text LIKE '%宿題%');
