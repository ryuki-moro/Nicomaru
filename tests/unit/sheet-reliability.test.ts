import { createClient } from '@supabase/supabase-js';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MyPage from '@/app/(couple)/mypage/page';
import MeetingSheetPage from '@/app/(staff)/cases/[caseId]/sheet/page';
import { recordSheet, requestSheetDraft } from '@/app/(staff)/cases/[caseId]/sheet/actions';

const { createServerClient, revalidatePath, requirePageUser } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  revalidatePath: vi.fn(),
  requirePageUser: vi.fn(),
}));
const actor = { id: '22222222-2222-4222-8222-222222222222', role: 'planner' };
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: createServerClient }));
vi.mock('@/lib/auth/session', () => ({
  requirePageUser,
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('@/app/(staff)/cases/[caseId]/sheet/SheetDraftPanel', () => ({
  SheetDraftPanel: () => null,
}));

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const task = {
  id: '33333333-3333-4333-8333-333333333333',
  title: '招待者リスト',
  due_date: '2030-01-01',
  status: 'not_started',
  display_order: 1,
};
const rows: Record<string, unknown[]> = {
  wedding_cases: [
    {
      id: CASE_ID,
      case_code: 'CASE01',
      wedding_date: '2030-02-01',
      venue_room: null,
      guest_count: 30,
      plan_types: null,
      user_profiles: null,
    },
  ],
  couple_profiles: [],
  case_tasks: [task],
  follow_logs: [],
  communication_logs: [],
  meeting_sheets: [],
  ai_jobs: [],
};

function databaseMock(
  options: {
    failRead?: string;
    failInsert?: boolean;
    failEnqueue?: boolean;
    profiles?: unknown[];
    emptyTasks?: boolean;
    missingCase?: boolean;
  } = {},
) {
  const inserts: Record<string, unknown>[] = [];
  const enqueues: Record<string, unknown>[] = [];
  const client = createClient('http://supabase.test', 'test-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const table = new URL(request.url).pathname.split('/').at(-1)!;
        if (request.method === 'POST' && table === 'meeting_sheets') {
          inserts.push(await request.json());
          return options.failInsert
            ? Response.json(
                { code: 'XX000', message: 'sensitive database detail' },
                { status: 500 },
              )
            : Response.json(null, { status: 201 });
        }
        if (table === 'enqueue_ai_job') {
          enqueues.push(await request.json());
          return options.failEnqueue
            ? Response.json(
                { code: 'XX000', message: 'sensitive database detail' },
                { status: 500 },
              )
            : Response.json('44444444-4444-4444-8444-444444444444');
        }
        if (options.failRead === table) {
          return Response.json(
            { code: 'XX000', message: 'sensitive database detail' },
            { status: 500 },
          );
        }
        if (table === 'ai_assist_status')
          return Response.json([{ available: false, last_seen_at: null }]);
        if (table === 'couple_profiles' && options.profiles) return Response.json(options.profiles);
        if (!(table in rows)) throw new Error(`Unexpected request: ${table}`);
        return Response.json(
          (options.emptyTasks && table === 'case_tasks') ||
            (options.missingCase && table === 'wedding_cases')
            ? []
            : rows[table],
        );
      },
    },
  });
  createServerClient.mockResolvedValue(client);
  return { inserts, enqueues };
}

function submittedForm(caseId = CASE_ID) {
  const form = new FormData();
  form.set('caseId', caseId);
  form.set('summary', JSON.stringify({ caseCode: 'FORGED', totalTasks: 999 }));
  return form;
}
const initialState = { status: 'idle' as const, message: '' };
const record = (caseId = CASE_ID) => recordSheet(initialState, submittedForm(caseId));
const sheetPage = () => MeetingSheetPage({ params: Promise.resolve({ caseId: CASE_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  requirePageUser.mockResolvedValue(actor);
});

describe('マイページの取得失敗と正常な0件の区別', () => {
  it.each(['case_tasks', 'couple_profiles'])(
    '%sの失敗を宿題なしとして表示しない',
    async (table) => {
      databaseMock({ failRead: table });
      const html = renderToStaticMarkup(await MyPage());
      expect(html).toContain('role="alert"');
      expect(html).not.toContain('いまお願いしている宿題はありません');
      expect(html).not.toContain('これから提出する宿題');
    },
  );
  it('正常な0件は宿題なしとして表示する', async () => {
    databaseMock({ emptyTasks: true });
    expect(renderToStaticMarkup(await MyPage())).toContain('いまお願いしている宿題はありません');
  });
});

describe('不完全な準備シートを印刷・記録しない', () => {
  it.each([
    'wedding_cases',
    'couple_profiles',
    'case_tasks',
    'follow_logs',
    'communication_logs',
    'meeting_sheets',
  ])('%sの取得失敗を表示する', async (table) => {
    databaseMock({ failRead: table });
    const html = renderToStaticMarkup(await sheetPage());
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('<article');
    expect(html).not.toContain('印刷する');
    expect(html).not.toContain('sensitive database detail');
  });
  it('本当に存在しない案件だけ404へ送る', async () => {
    databaseMock({ missingCase: true });
    await expect(sheetPage()).rejects.toThrow('REDIRECT:/error?code=404');
  });
  it('AI履歴だけの取得失敗は明示し、通常のシートは印刷できる', async () => {
    databaseMock({ failRead: 'ai_jobs' });
    const html = renderToStaticMarkup(await sheetPage());
    expect(html).toContain('AIの履歴を読み込めませんでした');
    expect(html).toContain('<article');
    expect(html).toContain('印刷する');
  });
  it('保存失敗を成功扱いせず再検証も行わない', async () => {
    databaseMock({ failInsert: true });
    const result = await record();
    expect(result).toMatchObject({ status: 'error' });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('sensitive database detail');
  });
  it('改ざんされたhidden集約を使わずサーバーの最新データを保存する', async () => {
    const { inserts } = databaseMock();
    const result = await record();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].summary_json).toMatchObject({
      caseCode: 'CASE01',
      totalTasks: 1,
      doneTasks: 0,
    });
    expect(result).toMatchObject({ status: 'success' });
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${CASE_ID}/sheet`);
  });
  it('表示後に取得が失敗した場合も空の集約を保存しない', async () => {
    databaseMock();
    await sheetPage();
    const { inserts } = databaseMock({ failRead: 'communication_logs' });
    expect(await record()).toMatchObject({ status: 'error' });
    expect(inserts).toHaveLength(0);
  });
  it('不正な案件IDでは保存しない', async () => {
    const { inserts } = databaseMock();
    expect(await record('invalid')).toMatchObject({ status: 'error' });
    expect(inserts).toHaveLength(0);
  });
  it('記録とAI依頼はスタッフ認証を要求し、拒否時はDBへ触れない', async () => {
    databaseMock();
    createServerClient.mockClear();
    requirePageUser.mockRejectedValue(new Error('REDIRECT:/mypage'));
    await expect(record()).rejects.toThrow('REDIRECT:/mypage');
    await expect(requestSheetDraft(initialState, submittedForm())).rejects.toThrow(
      'REDIRECT:/mypage',
    );
    expect(requirePageUser).toHaveBeenCalledWith('planner', 'admin', 'system_admin');
    expect(createServerClient).not.toHaveBeenCalled();
  });
  it('AI依頼の入力取得失敗ではジョブを作らない', async () => {
    const { enqueues } = databaseMock({ failRead: 'case_tasks' });
    const result = await requestSheetDraft(initialState, submittedForm());
    expect(result.status).toBe('error');
    expect(enqueues).toHaveLength(0);
  });
  it('AIジョブ投入失敗を成功と表示しない', async () => {
    databaseMock({ failEnqueue: true });
    const result = await requestSheetDraft(initialState, submittedForm());
    expect(result.status).toBe('error');
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('sensitive database detail');
  });
  it('AI依頼は取得した宿題を使い、氏名や連絡先を含めない', async () => {
    const { enqueues } = databaseMock({
      profiles: [
        { full_name: '模擬新郎', email: 'private@example.test', is_primary_contact: true },
      ],
    });
    const result = await requestSheetDraft(initialState, submittedForm());
    expect(result.status).toBe('success');
    expect(enqueues).toHaveLength(1);
    const input = enqueues[0].p_input_ref as { text: string };
    expect(input.text).toContain('招待者リスト');
    expect(input.text).not.toContain('FORGED');
    expect(input.text).not.toContain('模擬新郎');
    expect(input.text).not.toContain('private@example.test');
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${CASE_ID}/sheet`);
  });
});
