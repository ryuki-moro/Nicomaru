/**
 * RLSテスト — 基本設計書 Version 1.2 第11章「テスト設計」の RLSテスト行の合格基準を機械検証する。
 *
 * 合格基準（表11-1）:
 *   - 各ロール×各テーブルの select が 42P17（infinite recursion）を起こさないこと
 *   - couple が自分の role／venue_id を更新できないこと
 *   - admin が system_admin を作成できないこと
 *   - アーカイブ済み案件への update／delete が拒否されること
 *   - 停止（suspended）した利用者がアクセスできないこと
 *   - planner が自担当案件の couple_profiles を取得でき、user_profile_id が NULL の直後でも
 *     K01／K02 が0行にならないこと
 *   - couple が couple_profiles.memo を取得できないこと
 *   - couple が couple_profiles を insert／update／delete できないこと
 *   - planner／admin が case_invitations を取得でき、couple が取得できないこと
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { TestDb, seedFixture, type Fixture } from './harness';

/** RLS が有効なすべてのテーブル。42P17 の網羅チェックに用いる。 */
const RLS_TABLES = [
  'venues', 'user_profiles', 'plan_types', 'wedding_cases', 'couple_profiles',
  'case_invitations', 'case_guests', 'task_templates', 'plan_task_templates',
  'case_tasks', 'task_submissions', 'storage_files', 'timeline_items',
  'communication_logs', 'follow_logs', 'audit_logs', 'risk_rules',
  'risk_score_snapshots', 'notifications', 'notification_logs',
  'meeting_notes', 'meeting_sheets', 'ai_jobs', 'ai_prompt_templates',
] as const;

let db: TestDb;
let fx: Fixture;

beforeAll(async () => {
  db = await TestDb.create();
  fx = await seedFixture(db);
});

afterAll(async () => {
  await db?.close();
});

/** 例外を握りつぶして SQLSTATE を返す。 */
async function errcodeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return e.code ?? e.message ?? 'unknown';
  }
}

describe('42P17（ポリシーの相互再帰）が起きないこと', () => {
  it('各ロール × RLS有効な全テーブルの select が成功する', async () => {
    const users = [fx.systemAdmin, fx.admin, fx.planner, fx.couple];
    const failures: string[] = [];

    for (const user of users) {
      await db.asUser(user.authUserId, async () => {
        for (const table of RLS_TABLES) {
          try {
            // couple_profiles は memo を列レベルで剥奪しているため select * は意図的に拒否される。
            // ここで見たいのは 42P17（相互再帰）の有無なので、許可列だけを読む。
            const cols = table === 'couple_profiles' ? 'id, case_id, partner_role' : '*';
            await db.query(`select ${cols} from ${table} limit 1`);
          } catch (error) {
            const e = error as { code?: string; message?: string };
            failures.push(`${user.role}/${table}: ${e.code ?? ''} ${e.message ?? ''}`);
          }
        }
      });
    }

    expect(failures).toEqual([]);
  });
});

describe('案件のスコープ', () => {
  it('planner は自担当案件のみ、admin は式場内全件を参照できる', async () => {
    const asPlanner = await db.asUser(fx.planner.authUserId, () =>
      db.query<{ id: string }>('select id from wedding_cases'));
    expect(asPlanner.rows.map((r) => r.id)).toEqual([fx.caseId]);

    const asAdmin = await db.asUser(fx.admin.authUserId, () =>
      db.query<{ id: string }>('select id from wedding_cases order by case_code'));
    // admin は自式場の進行中＋アーカイブ済みを参照できる（can_see_archived）
    expect(asAdmin.rows.map((r) => r.id).sort())
      .toEqual([fx.caseId, fx.archivedCaseId].sort());
    expect(asAdmin.rows.map((r) => r.id)).not.toContain(fx.otherCaseId);
  });

  it('couple は自分の案件のみ参照でき、他式場の案件は見えない', async () => {
    const rows = await db.asUser(fx.couple.authUserId, () =>
      db.query<{ id: string }>('select id from wedding_cases'));
    expect(rows.rows.map((r) => r.id)).toEqual([fx.caseId]);
  });

  it('別式場の admin は当該式場の案件を参照できない', async () => {
    const rows = await db.asUser(fx.otherVenueAdmin.authUserId, () =>
      db.query<{ id: string }>('select id from wedding_cases'));
    expect(rows.rows.map((r) => r.id)).toEqual([fx.otherCaseId]);
  });

  it('planner にはアーカイブ済み案件が見えない（restrictive ポリシー）', async () => {
    const rows = await db.asUser(fx.planner.authUserId, () =>
      db.query<{ id: string }>('select id from wedding_cases where id = $1', [fx.archivedCaseId]));
    expect(rows.rows).toHaveLength(0);
  });
});

describe('停止・削除した利用者の遮断（13-1 セッション失効）', () => {
  it('suspended の planner はセッションが生きていても0行になる', async () => {
    const rows = await db.asUser(fx.suspendedPlanner.authUserId, () =>
      db.query('select id from wedding_cases'));
    expect(rows.rows).toHaveLength(0);
  });

  it('未認証（auth.uid() が NULL）では業務テーブルが0行になる', async () => {
    const rows = await db.asUser(null, () => db.query('select id from wedding_cases'));
    expect(rows.rows).toHaveLength(0);
  });
});

describe('権限昇格の防止（rank 5）', () => {
  it('couple は自分の role を変更できない', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(`update user_profiles set role = 'admin' where auth_user_id = auth.uid()`));
      // WITH CHECK 違反は 42501（new row violates row-level security policy）
      expect(code).toBe('42501');
    });
    const after = await db.asOwner(() =>
      db.query<{ role: string }>('select role from user_profiles where id = $1', [fx.couple.profileId]));
    expect(after.rows[0].role).toBe('couple');
  });

  it('couple は自分の venue_id を変更できない', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(`update user_profiles set venue_id = $1 where auth_user_id = auth.uid()`,
          [fx.otherVenueId]));
      expect(code).toBe('42501');
    });
  });

  it('couple は自分の status を変更できない（停止の自己解除）', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(`update user_profiles set status = 'suspended' where auth_user_id = auth.uid()`));
      expect(code).toBe('42501');
    });
  });

  it('couple は表示名・電話なら自分で変更できる', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const r = await db.query(
        `update user_profiles set display_name = '新しい表示名' where auth_user_id = auth.uid()
         returning display_name`);
      expect(r.rows).toHaveLength(1);
    });
  });

  it('admin は system_admin を作成できない', async () => {
    await db.asUser(fx.admin.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(
          `insert into user_profiles (auth_user_id, venue_id, role, display_name, email)
           values (gen_random_uuid(), null, 'system_admin', 'x', 'x@example.test')`));
      expect(code).not.toBeNull();
    });
  });

  it('admin は自式場の planner なら作成できる', async () => {
    await db.asOwner(() =>
      db.query(`insert into auth.users (id, email)
                values ('99999999-9999-4999-8999-999999999999', 'newplanner@example.test')`));
    await db.asUser(fx.admin.authUserId, async () => {
      const r = await db.query(
        `insert into user_profiles (auth_user_id, venue_id, role, display_name, email, status)
         values ('99999999-9999-4999-8999-999999999999', $1, 'planner', '新任', 'newplanner@example.test', 'invited')
         returning id`,
        [fx.venueId]);
      expect(r.rows).toHaveLength(1);
    });
  });

  it('admin は別式場の planner を作成できない', async () => {
    await db.asUser(fx.admin.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(
          `insert into user_profiles (auth_user_id, venue_id, role, display_name, email)
           values (gen_random_uuid(), $1, 'planner', 'x', 'x2@example.test')`,
          [fx.otherVenueId]));
      expect(code).not.toBeNull();
    });
  });
});

describe('アーカイブ済み案件の保護（rank 5 / 付録A）', () => {
  it('admin でもアーカイブ済み案件を delete できない', async () => {
    await db.asUser(fx.admin.authUserId, async () => {
      const r = await db.query('delete from wedding_cases where id = $1 returning id',
        [fx.archivedCaseId]);
      expect(r.rows).toHaveLength(0);
    });
  });

  it('planner はアーカイブ済み案件を update できない', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const r = await db.query(
        `update wedding_cases set notes = 'x' where id = $1 returning id`, [fx.archivedCaseId]);
      expect(r.rows).toHaveLength(0);
    });
  });

  it('進行中の案件は物理削除できない（cases_delete using(false)）', async () => {
    await db.asUser(fx.admin.authUserId, async () => {
      const r = await db.query('delete from wedding_cases where id = $1 returning id', [fx.caseId]);
      expect(r.rows).toHaveLength(0);
    });
  });
});

describe('couple_profiles（rank 2 / rank 6）', () => {
  it('planner は自担当案件の couple_profiles を2行取得できる（user_profile_id が NULL でも）', async () => {
    const rows = await db.asUser(fx.planner.authUserId, () =>
      db.query<{ partner_role: string }>(
        'select partner_role from couple_profiles where case_id = $1 order by partner_role',
        [fx.caseId]));
    expect(rows.rows.map((r) => r.partner_role)).toEqual(['bride', 'groom']);
  });

  it('select * は memo を含むため意図的に拒否される（誤って全列を読む実装を早期に落とす）', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() => db.query('select * from couple_profiles'));
      expect(code).toBe('42501');
    });
  });

  it('couple は memo 列を取得できない（列レベル権限）', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() => db.query('select memo from couple_profiles'));
      expect(code).toBe('42501');
    });
  });

  it('couple は memo 以外の列なら取得できる（同一案件のパートナー行も含む）', async () => {
    const rows = await db.asUser(fx.couple.authUserId, () =>
      db.query('select id, full_name from couple_profiles'));
    expect(rows.rows).toHaveLength(2);
  });

  it('planner は get_couple_memo() 経由で memo を参照できる', async () => {
    const target = await db.asOwner(() =>
      db.query<{ id: string }>(
        `select id from couple_profiles where case_id = $1 and partner_role = 'groom'`, [fx.caseId]));
    const rows = await db.asUser(fx.planner.authUserId, () =>
      db.query<{ get_couple_memo: string | null }>('select get_couple_memo($1)', [target.rows[0].id]));
    expect(rows.rows[0].get_couple_memo).toContain('読めてはいけない');
  });

  it('couple は get_couple_memo() を呼んでも NULL しか得られない', async () => {
    const target = await db.asOwner(() =>
      db.query<{ id: string }>(
        `select id from couple_profiles where case_id = $1 and partner_role = 'groom'`, [fx.caseId]));
    const rows = await db.asUser(fx.couple.authUserId, () =>
      db.query<{ get_couple_memo: string | null }>('select get_couple_memo($1)', [target.rows[0].id]));
    expect(rows.rows[0].get_couple_memo).toBeNull();
  });

  it('couple は couple_profiles を insert／update／delete できない', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const insertCode = await errcodeOf(() =>
        db.query(`insert into couple_profiles (case_id, partner_role, full_name)
                  values ($1, 'partner_a', 'x')`, [fx.caseId]));
      expect(insertCode).toBe('42501');

      const updated = await db.query(
        `update couple_profiles set full_name = 'x' where case_id = $1 returning id`, [fx.caseId]);
      expect(updated.rows).toHaveLength(0);

      const deleted = await db.query(
        'delete from couple_profiles where case_id = $1 returning id', [fx.caseId]);
      expect(deleted.rows).toHaveLength(0);
    });
  });

  it('主連絡先は案件ごとに1行に制限される', async () => {
    await db.asOwner(async () => {
      const code = await errcodeOf(() =>
        db.query(`update couple_profiles set is_primary_contact = true
                  where case_id = $1 and partner_role = 'bride'`, [fx.caseId]));
      expect(code).toBe('23505');
    });
  });
});

describe('case_invitations（rank 4）', () => {
  it('planner は招待を参照できる', async () => {
    const rows = await db.asUser(fx.planner.authUserId, () =>
      db.query('select id from case_invitations where case_id = $1', [fx.caseId]));
    expect(rows.rows).toHaveLength(1);
  });

  it('couple は招待を参照できない', async () => {
    const rows = await db.asUser(fx.couple.authUserId, () =>
      db.query('select id from case_invitations'));
    expect(rows.rows).toHaveLength(0);
  });

  it('有効な招待は (case_id, target_partner_role, purpose) ごとに1件に制限される', async () => {
    await db.asOwner(async () => {
      const code = await errcodeOf(() =>
        db.query(
          `insert into case_invitations
             (case_id, invited_by, target_partner_role, token_hash, purpose, expires_at)
           values ($1, $2, 'bride', 'hash-bride-2', 'initial_registration', now() + interval '14 days')`,
          [fx.caseId, fx.planner.profileId]));
      expect(code).toBe('23505');
    });
  });

  it('失効させれば再発行できる', async () => {
    await db.asOwner(async () => {
      await db.query('update case_invitations set revoked_at = now() where id = $1', [fx.invitationId]);
      const r = await db.query(
        `insert into case_invitations
           (case_id, invited_by, target_partner_role, token_hash, purpose, expires_at)
         values ($1, $2, 'bride', 'hash-bride-3', 'initial_registration', now() + interval '14 days')
         returning id`,
        [fx.caseId, fx.planner.profileId]);
      expect(r.rows).toHaveLength(1);
      // 後続テストのために元へ戻す
      await db.query(`update case_invitations set revoked_at = now() where token_hash = 'hash-bride-3'`);
      await db.query('update case_invitations set revoked_at = null where id = $1', [fx.invitationId]);
    });
  });
});

describe('提出（rank 1 / rank 7 / 6-7）', () => {
  it('couple は submit_task() 経由で case_tasks の状態を進められる', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      await db.query('select submit_task($1, $2)', [fx.taskId, 'submitted']);
    });
    const after = await db.asOwner(() =>
      db.query<{ status: string; last_submitted_at: string | null }>(
        'select status, last_submitted_at from case_tasks where id = $1', [fx.taskId]));
    expect(after.rows[0].status).toBe('submitted');
    expect(after.rows[0].last_submitted_at).not.toBeNull();
  });

  it('couple は case_tasks を直接 update できない', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const r = await db.query(
        `update case_tasks set status = 'confirmed' where id = $1 returning id`, [fx.taskId]);
      expect(r.rows).toHaveLength(0);
    });
  });

  it('couple は submit_task() で confirmed に飛べない', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() => db.query('select submit_task($1, $2)', [fx.taskId, 'confirmed']));
      expect(code).toBe('42501');
    });
  });

  it('planner は submit_task() を呼べない（couple 専用の経路）', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() => db.query('select submit_task($1, $2)', [fx.taskId, 'submitted']));
      expect(code).toBe('42501');
    });
  });

  it('couple は自分の draft を insert でき、planner には見えない', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const r = await db.query(
        `insert into task_submissions (case_task_id, submitted_by, submission_type, text_value, review_status)
         values ($1, $2, 'text', 'かきかけ', 'draft') returning id`,
        [fx.taskId, fx.couple.profileId]);
      expect(r.rows).toHaveLength(1);
    });

    const plannerView = await db.asUser(fx.planner.authUserId, () =>
      db.query('select id from task_submissions where case_task_id = $1', [fx.taskId]));
    expect(plannerView.rows).toHaveLength(0);

    const coupleView = await db.asUser(fx.couple.authUserId, () =>
      db.query('select id from task_submissions where case_task_id = $1', [fx.taskId]));
    expect(coupleView.rows).toHaveLength(1);
  });

  it('couple は自分の未レビュー提出を上書きできる（6-7）', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const r = await db.query(
        `update task_submissions set text_value = 'ていしゅつ', review_status = 'submitted'
          where case_task_id = $1 returning id`, [fx.taskId]);
      expect(r.rows).toHaveLength(1);
    });
  });

  it('couple は自分で confirmed を付けられない', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(`update task_submissions set review_status = 'confirmed' where case_task_id = $1`,
          [fx.taskId]));
      expect(code).toBe('42501');
    });
  });

  it('planner は submitted を confirmed にできる', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const r = await db.query(
        `update task_submissions set review_status = 'confirmed', reviewed_by = $2, reviewed_at = now()
          where case_task_id = $1 returning id`, [fx.taskId, fx.planner.profileId]);
      expect(r.rows).toHaveLength(1);
    });
  });

  it('最新提出は case_task_id ごと1件に制限される', async () => {
    await db.asOwner(async () => {
      const code = await errcodeOf(() =>
        db.query(
          `insert into task_submissions (case_task_id, submitted_by, submission_type, review_status, is_latest)
           values ($1, $2, 'text', 'submitted', true)`,
          [fx.taskId, fx.couple.profileId]));
      expect(code).toBe('23505');
    });
  });

  it("submission_type は none を受け付ける（v1.2 で4値へ統一）", async () => {
    await db.asOwner(async () => {
      const t = await db.query<{ id: string }>(
        `insert into case_tasks (case_id, title, submission_format, due_date)
         values ($1, '当日の進行表の確認', 'none', current_date + 14) returning id`, [fx.caseId]);
      const r = await db.query(
        `insert into task_submissions (case_task_id, submitted_by, submission_type, review_status)
         values ($1, $2, 'none', 'submitted') returning id`,
        [t.rows[0].id, fx.couple.profileId]);
      expect(r.rows).toHaveLength(1);
    });
  });
});

describe('監査ログ（9-1）', () => {
  it('system_admin のみ参照でき、planner からは0行', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      await db.query(`select log_audit('case.update', 'wedding_cases', $1, '{"fields":["notes"]}'::jsonb)`,
        [fx.caseId]);
      const rows = await db.query('select id from audit_logs');
      expect(rows.rows).toHaveLength(0);
    });

    const asSysAdmin = await db.asUser(fx.systemAdmin.authUserId, () =>
      db.query<{ actor_user_id: string }>('select actor_user_id from audit_logs'));
    expect(asSysAdmin.rows).toHaveLength(1);
    // actor は引数ではなく auth.uid() から解決される（偽装できない）
    expect(asSysAdmin.rows[0].actor_user_id).toBe(fx.planner.profileId);
  });

  it('authenticated は audit_logs へ直接 insert／delete できない', async () => {
    await db.asUser(fx.systemAdmin.authUserId, async () => {
      const insertCode = await errcodeOf(() =>
        db.query(`insert into audit_logs (action, target_type) values ('x', 'y')`));
      expect(insertCode).toBe('42501');
      const deleteCode = await errcodeOf(() => db.query('delete from audit_logs'));
      expect(deleteCode).toBe('42501');
    });
  });
});

describe('マスタ・レート制限', () => {
  it('planner は自式場のテンプレートを参照でき、更新はできない', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const rows = await db.query('select id from task_templates');
      expect(rows.rows.length).toBeGreaterThan(0);
      const updated = await db.query(
        `update task_templates set name = 'x' where venue_id = $1 returning id`, [fx.venueId]);
      expect(updated.rows).toHaveLength(0);
    });
  });

  it('admin は自式場のテンプレートを更新できる', async () => {
    await db.asUser(fx.admin.authUserId, async () => {
      const r = await db.query(
        `update task_templates set description = '更新' where venue_id = $1 returning id`,
        [fx.venueId]);
      expect(r.rows.length).toBeGreaterThan(0);
    });
  });

  it('auth_rate_limits は authenticated から直接触れない', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() => db.query('select * from auth_rate_limits'));
      expect(code).toBe('42501');
    });
  });

  it('check_rate_limit() は上限を超えると false を返す', async () => {
    await db.asOwner(async () => {
      const results: boolean[] = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await db.query<{ check_rate_limit: boolean }>(
          `select check_rate_limit('otp_request', 'hash-a', 3600, 3)`);
        results.push(r.rows[0].check_rate_limit);
      }
      expect(results).toEqual([true, true, true, false]);
    });
  });
});

describe('案件番号の採番（5-7）', () => {
  it('式場×年で連番が採れる', async () => {
    await db.asOwner(async () => {
      const r = await db.query<{ next_case_code: string }>(
        'select next_case_code($1, 2026)', [fx.venueId]);
      // フィクスチャで 0001・0002 を使用済み
      expect(r.rows[0].next_case_code).toBe('BRIDAL01-2026-0003');
      const nextYear = await db.query<{ next_case_code: string }>(
        'select next_case_code($1, 2027)', [fx.venueId]);
      expect(nextYear.rows[0].next_case_code).toBe('BRIDAL01-2027-0001');
    });
  });
});
