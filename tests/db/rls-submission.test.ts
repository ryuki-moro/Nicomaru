/**
 * 提出フローに関する RLS テスト（第11章）。
 *
 * 20260828000900_submission_functions.sql で補完した権限を検証する。
 * 実装時に「6-7 の中心導線（提出 → 不備あり → 再提出）が RLS で塞がっている」ことが
 * 判明したため、退行しないようテストで固定する。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { TestDb, seedFixture, type Fixture } from './harness';

let db: TestDb;
let fx: Fixture;

beforeAll(async () => {
  db = await TestDb.create();
  fx = await seedFixture(db);
});

afterAll(async () => {
  await db?.close();
});

async function errcodeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return e.code ?? e.message ?? 'unknown';
  }
}

describe('再提出フロー（6-7 needs_fix → 再提出）', () => {
  let taskId: string;

  beforeAll(async () => {
    const t = await db.asOwner(() =>
      db.query<{ id: string }>(
        `insert into case_tasks (case_id, title, submission_format, due_date)
         values ($1, 'BGMリクエスト', 'text', current_date + 45) returning id`,
        [fx.caseId]));
    taskId = t.rows[0].id;

    // プランナーが「不備あり」を付けた状態を作る
    await db.asOwner(() =>
      db.query(
        `insert into task_submissions
           (case_task_id, submitted_by, submission_type, text_value, review_status, is_latest)
         values ($1, $2, 'text', 'v1', 'needs_fix', true)`,
        [taskId, fx.couple.profileId]));
  });

  it('couple は needs_fix の行を直接 update できない（付録A の意図どおり）', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const r = await db.query(
        'update task_submissions set is_latest = false where case_task_id = $1 returning id',
        [taskId]);
      expect(r.rows).toHaveLength(0);
    });
  });

  it('直接 insert すると部分ユニークで弾かれる（降格が先に要る）', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(
          `insert into task_submissions
             (case_task_id, submitted_by, submission_type, text_value, review_status, is_latest)
           values ($1, $2, 'text', 'v2', 'submitted', true)`,
          [taskId, fx.couple.profileId]));
      expect(code).toBe('23505');
    });
  });

  it('demote_latest_submission() を通せば降格でき、新しい提出を作れる', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const demoted = await db.query<{ demote_latest_submission: string | null }>(
        'select demote_latest_submission($1)', [taskId]);
      expect(demoted.rows[0].demote_latest_submission).not.toBeNull();

      const inserted = await db.query(
        `insert into task_submissions
           (case_task_id, submitted_by, submission_type, text_value, review_status, is_latest)
         values ($1, $2, 'text', 'v2', 'submitted', true) returning id`,
        [taskId, fx.couple.profileId]);
      expect(inserted.rows).toHaveLength(1);
    });

    const rows = await db.asOwner(() =>
      db.query<{ n: number }>(
        'select count(*)::int as n from task_submissions where case_task_id = $1 and is_latest',
        [taskId]));
    expect(rows.rows[0].n).toBe(1);
  });

  it('降格対象が無ければ NULL を返す（未レビュー提出は上書きが正しい経路）', async () => {
    const rows = await db.asUser(fx.couple.authUserId, () =>
      db.query<{ demote_latest_submission: string | null }>(
        'select demote_latest_submission($1)', [taskId]));
    expect(rows.rows[0].demote_latest_submission).toBeNull();
  });

  it('planner は demote_latest_submission() を呼べない（提出は couple の操作）', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() => db.query('select demote_latest_submission($1)', [taskId]));
      expect(code).toBe('42501');
    });
  });

  it('案件に紐付いていない couple は呼べない', async () => {
    await db.asUser(fx.partner.authUserId, async () => {
      const code = await errcodeOf(() => db.query('select demote_latest_submission($1)', [taskId]));
      expect(code).toBe('42501');
    });
  });
});

describe('連絡履歴の自動記録（log_communication）', () => {
  it('couple は直接 insert できないが、関数経由なら記録できる', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const direct = await errcodeOf(() =>
        db.query(
          `insert into communication_logs (case_id, channel, direction, source, summary, occurred_at)
           values ($1, 'in_app', 'inbound', 'submit', 'x', now())`,
          [fx.caseId]));
      expect(direct).toBe('42501');

      await db.query('select log_communication($1, $2, $3, $4, $5)',
        [fx.caseId, 'in_app', 'inbound', 'submit', '宿題が提出されました']);
    });

    const rows = await db.asUser(fx.planner.authUserId, () =>
      db.query<{ created_by: string; source: string }>(
        'select created_by, source from communication_logs where case_id = $1', [fx.caseId]));
    expect(rows.rows).toHaveLength(1);
    // created_by は引数ではなく auth.uid() から解決される（実行者を偽装できない）
    expect(rows.rows[0].created_by).toBe(fx.couple.profileId);
    expect(rows.rows[0].source).toBe('submit');
  });

  it('couple には連絡履歴の参照を許さない（planner／admin 向け情報）', async () => {
    const rows = await db.asUser(fx.couple.authUserId, () =>
      db.query('select id from communication_logs'));
    expect(rows.rows).toHaveLength(0);
  });

  it('触れない案件には記録できない', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query('select log_communication($1, $2, $3, $4, $5)',
          [fx.otherCaseId, 'in_app', 'inbound', 'submit', 'x']));
      expect(code).toBe('42501');
    });
  });
});

describe('提出ファイルのメタ情報（storage_files）', () => {
  it('couple は自分の案件へ登録でき、置き換え時に削除できる（6-7 の孤児対策）', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const inserted = await db.query<{ id: string }>(
        `insert into storage_files (case_id, uploaded_by, object_path, mime_type, file_size_bytes)
         values ($1, $2, $3, 'text/csv', 1024) returning id`,
        [fx.caseId, fx.couple.profileId, `${fx.venueId}/${fx.caseId}/t/f1.csv`]);
      expect(inserted.rows).toHaveLength(1);

      const deleted = await db.query(
        'delete from storage_files where id = $1 returning id', [inserted.rows[0].id]);
      expect(deleted.rows).toHaveLength(1);
    });
  });

  it('planner_only のファイルは couple から見えない（6-11）', async () => {
    const file = await db.asOwner(() =>
      db.query<{ id: string }>(
        `insert into storage_files (case_id, uploaded_by, object_path, visibility)
         values ($1, $2, $3, 'planner_only') returning id`,
        [fx.caseId, fx.planner.profileId, `${fx.venueId}/${fx.caseId}/sheet.pdf`]));

    const asCouple = await db.asUser(fx.couple.authUserId, () =>
      db.query('select id from storage_files where id = $1', [file.rows[0].id]));
    expect(asCouple.rows).toHaveLength(0);

    const asPlanner = await db.asUser(fx.planner.authUserId, () =>
      db.query('select id from storage_files where id = $1', [file.rows[0].id]));
    expect(asPlanner.rows).toHaveLength(1);
  });

  it('他案件のファイルは削除できない', async () => {
    const file = await db.asOwner(() =>
      db.query<{ id: string }>(
        `insert into storage_files (case_id, uploaded_by, object_path)
         values ($1, $2, $3) returning id`,
        [fx.otherCaseId, fx.otherVenueAdmin.profileId, 'other/f.csv']));

    await db.asUser(fx.couple.authUserId, async () => {
      const r = await db.query('delete from storage_files where id = $1 returning id',
        [file.rows[0].id]);
      expect(r.rows).toHaveLength(0);
    });
  });
});

describe('invited→active の遷移（complete_invite）', () => {
  it('本人セッションからの直接 update は通らないが、関数経由なら遷移できる', async () => {
    const invited = await db.asOwner(async () => {
      const auth = await db.query<{ id: string }>(
        "insert into auth.users (email) values ('invited@example.test') returning id");
      await db.query(
        `insert into user_profiles (auth_user_id, venue_id, role, display_name, email, status)
         values ($1, $2, 'planner', '招待中', 'invited@example.test', 'invited')`,
        [auth.rows[0].id, fx.venueId]);
      return auth.rows[0].id;
    });

    // current_app_user() は status='active' を必須条件とするため、invited の行では0行を返す。
    // その結果 user_profiles_update_self の WITH CHECK が NULL 比較で成立せず、
    // 本人セッションからの直接 UPDATE は 42501 で拒否される（invited から自力で抜けられない）。
    await db.asUser(invited, async () => {
      const code = await errcodeOf(() =>
        db.query("update user_profiles set status = 'active' where auth_user_id = auth.uid()"));
      expect(code).toBe('42501');
    });

    await db.asUser(invited, async () => {
      const r = await db.query<{ complete_invite: string }>('select complete_invite()');
      expect(r.rows[0].complete_invite).toBe('activated');
    });

    const after = await db.asOwner(() =>
      db.query<{ status: string }>(
        "select status from user_profiles where email = 'invited@example.test'"));
    expect(after.rows[0].status).toBe('active');
  });

  it('2回目は already_active（冪等）', async () => {
    const authId = await db.asOwner(async () => {
      const r = await db.query<{ auth_user_id: string }>(
        "select auth_user_id from user_profiles where email = 'invited@example.test'");
      return r.rows[0].auth_user_id;
    });
    const r = await db.asUser(authId, () =>
      db.query<{ complete_invite: string }>('select complete_invite()'));
    expect(r.rows[0].complete_invite).toBe('already_active');
  });

  it('既に active な利用者は already_active（couple は初回登録時から active）', async () => {
    const r = await db.asUser(fx.couple.authUserId, () =>
      db.query<{ complete_invite: string }>('select complete_invite()'));
    expect(r.rows[0].complete_invite).toBe('already_active');
  });

  it('invited の couple は not_allowed（この経路は staff の初回設定専用）', async () => {
    const authId = await db.asOwner(async () => {
      const auth = await db.query<{ id: string }>(
        "insert into auth.users (email) values ('invited-couple@example.test') returning id");
      await db.query(
        `insert into user_profiles (auth_user_id, venue_id, role, display_name, email, status)
         values ($1, $2, 'couple', '招待中couple', 'invited-couple@example.test', 'invited')`,
        [auth.rows[0].id, fx.venueId]);
      return auth.rows[0].id;
    });
    const r = await db.asUser(authId, () =>
      db.query<{ complete_invite: string }>('select complete_invite()'));
    expect(r.rows[0].complete_invite).toBe('not_allowed');
  });
});

/**
 * 提出は「案件」単位で共有する（6-7／20260828001000_submission_sharing.sql）。
 *
 * 新郎新婦は1つの案件・同じ case_tasks を共有し（2-3、6-6-1 は両方に招待を発行する）、
 * 宿題1件に対する最新提出も task_submissions_latest_uk により1行しか持てない。
 * 個人単位で書かれていた実装では「相手が一時保存すると、もう一方が二度と提出できない」
 * 状態になっていたため、案件単位で成立することをここで固定する。
 */
describe('提出の案件共有（6-7 新郎新婦は同じ宿題に1つの提出を持つ）', () => {
  let taskId: string;
  let bride: { authUserId: string; profileId: string };
  let otherCouple: { authUserId: string; profileId: string };

  beforeAll(async () => {
    const setup = await db.asOwner(async () => {
      // fixture の bride 側 couple_profiles は未招待（user_profile_id が NULL）。
      // 6-6-1 は新郎新婦の両方に招待を発行するので、両方が登録済みの通常状態を作る。
      const brideAuth = await db.query<{ id: string }>(
        "insert into auth.users (email) values ('bride-linked@example.test') returning id");
      const brideProfile = await db.query<{ id: string }>(
        `insert into user_profiles (auth_user_id, venue_id, role, display_name, email, status)
         values ($1, $2, 'couple', '山田 花子', 'bride-linked@example.test', 'active')
         returning id`,
        [brideAuth.rows[0].id, fx.venueId]);
      await db.query(
        `update couple_profiles set user_profile_id = $1
          where case_id = $2 and partner_role = 'bride'`,
        [brideProfile.rows[0].id, fx.caseId]);

      // 別案件の couple（案件をまたいで提出状態を覗けないことの確認用）
      const otherAuth = await db.query<{ id: string }>(
        "insert into auth.users (email) values ('other-couple@example.test') returning id");
      const otherProfile = await db.query<{ id: string }>(
        `insert into user_profiles (auth_user_id, venue_id, role, display_name, email, status)
         values ($1, $2, 'couple', '別案件の新郎', 'other-couple@example.test', 'active')
         returning id`,
        [otherAuth.rows[0].id, fx.otherVenueId]);
      await db.query(
        `insert into couple_profiles (case_id, user_profile_id, partner_role, full_name)
         values ($1, $2, 'groom', '別案件 太郎')`,
        [fx.otherCaseId, otherProfile.rows[0].id]);

      const t = await db.query<{ id: string }>(
        `insert into case_tasks (case_id, title, submission_format, due_date)
         values ($1, '席次表の確認', 'text', current_date + 30) returning id`,
        [fx.caseId]);

      return {
        taskId: t.rows[0].id,
        bride: { authUserId: brideAuth.rows[0].id, profileId: brideProfile.rows[0].id },
        otherCouple: { authUserId: otherAuth.rows[0].id, profileId: otherProfile.rows[0].id },
      };
    });
    taskId = setup.taskId;
    bride = setup.bride;
    otherCouple = setup.otherCouple;

    // 新郎が一時保存した状態を作る（本人セッションなので insert ポリシーで通る）
    await db.asUser(fx.couple.authUserId, () =>
      db.query(
        `insert into task_submissions
           (case_task_id, submitted_by, submission_type, text_value, review_status, is_latest)
         values ($1, $2, 'text', 'groom-draft', 'draft', true)`,
        [taskId, fx.couple.profileId]));
  });

  it('相手の draft でも案件メンバーなら状態を取得できる（中身は隠れたまま）', async () => {
    await db.asUser(bride.authUserId, async () => {
      // 付録A の「一時保存は本人以外に見せない」は維持する。直読みは0行のまま。
      const direct = await db.query(
        'select id from task_submissions where case_task_id = $1', [taskId]);
      expect(direct.rows).toHaveLength(0);

      const r = await db.query<{ review_status: string; submitted_by: string }>(
        'select review_status, submitted_by from latest_submission_for_task($1)', [taskId]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].review_status).toBe('draft');
      expect(r.rows[0].submitted_by).toBe(fx.couple.profileId);
    });
  });

  it('相手の draft は所有権を移してから上書きでき、submitted_by が付け替わる', async () => {
    await db.asUser(bride.authUserId, async () => {
      // UPDATE の WHERE／RETURNING には select ポリシーも効くため、
      // 所有権を移す前は update ポリシーを案件単位に広げても0行更新のままになる。
      const blocked = await db.query(
        `update task_submissions set text_value = 'bride-v1'
          where case_task_id = $1 and is_latest returning id`, [taskId]);
      expect(blocked.rows).toHaveLength(0);

      const claimed = await db.query<{ claim_latest_submission: string | null }>(
        'select claim_latest_submission($1)', [taskId]);
      expect(claimed.rows[0].claim_latest_submission).not.toBeNull();

      const updated = await db.query(
        `update task_submissions
            set text_value = 'bride-v1', submitted_by = $2, review_status = 'submitted'
          where case_task_id = $1 and is_latest returning id`,
        [taskId, bride.profileId]);
      expect(updated.rows).toHaveLength(1);
    });

    const row = await db.asOwner(() =>
      db.query<{ submitted_by: string; text_value: string; review_status: string }>(
        `select submitted_by, text_value, review_status from task_submissions
          where case_task_id = $1 and is_latest`, [taskId]));
    expect(row.rows[0].submitted_by).toBe(bride.profileId);
    expect(row.rows[0].text_value).toBe('bride-v1');
    expect(row.rows[0].review_status).toBe('submitted');
  });

  it('相手の submitted（未レビュー）はそのまま上書きできる', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const updated = await db.query(
        `update task_submissions
            set text_value = 'groom-v2', submitted_by = $2
          where case_task_id = $1 and is_latest returning id`,
        [taskId, fx.couple.profileId]);
      expect(updated.rows).toHaveLength(1);
    });
  });

  it('上書きに乗じて review_status を confirmed へ上げられない（権限昇格の退行防止）', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(
          `update task_submissions set review_status = 'confirmed'
            where case_task_id = $1 and is_latest`, [taskId]));
      expect(code).toBe('42501');
    });
  });

  it('planner は latest_submission_for_task を呼べない（draft を素通しさせない）', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query('select * from latest_submission_for_task($1)', [taskId]));
      expect(code).toBe('42501');
    });
  });

  it('他案件の couple は取得も所有権移転も呼べない', async () => {
    await db.asUser(otherCouple.authUserId, async () => {
      expect(await errcodeOf(() =>
        db.query('select * from latest_submission_for_task($1)', [taskId]))).toBe('42501');
      expect(await errcodeOf(() =>
        db.query('select claim_latest_submission($1)', [taskId]))).toBe('42501');
    });
  });

  it('confirmed からの再提出で confirmed_by／confirmed_at が NULL に戻る（3-3-4）', async () => {
    const reTaskId = await db.asOwner(async () => {
      const t = await db.query<{ id: string }>(
        `insert into case_tasks (case_id, title, submission_format, due_date, status,
                                 confirmed_by, confirmed_at)
         values ($1, '衣装の最終確認', 'text', current_date + 20, 'confirmed', $2, now())
         returning id`,
        [fx.caseId, fx.planner.profileId]);
      await db.query(
        `insert into task_submissions
           (case_task_id, submitted_by, submission_type, text_value, review_status, is_latest)
         values ($1, $2, 'text', 'v1', 'confirmed', true)`,
        [t.rows[0].id, fx.couple.profileId]);
      return t.rows[0].id;
    });

    // 確認したのは新郎の提出だが、出し直すのは新婦でもよい（提出は案件単位）
    await db.asUser(bride.authUserId, async () => {
      const demoted = await db.query<{ demote_latest_submission: string | null }>(
        'select demote_latest_submission($1)', [reTaskId]);
      expect(demoted.rows[0].demote_latest_submission).not.toBeNull();

      await db.query(
        `insert into task_submissions
           (case_task_id, submitted_by, submission_type, text_value, review_status, is_latest)
         values ($1, $2, 'text', 'v2', 'submitted', true)`,
        [reTaskId, bride.profileId]);
      await db.query('select submit_task($1, $2)', [reTaskId, 'submitted']);
    });

    const after = await db.asOwner(() =>
      db.query<{ status: string; confirmed_by: string | null; confirmed_at: string | null }>(
        'select status, confirmed_by, confirmed_at from case_tasks where id = $1', [reTaskId]));
    expect(after.rows[0].status).toBe('submitted');
    expect(after.rows[0].confirmed_by).toBeNull();
    expect(after.rows[0].confirmed_at).toBeNull();
  });
});
