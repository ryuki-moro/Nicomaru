import {
  COUPLE_PROFILE_COLUMNS,
  INCOMPLETE_TASK_STATUSES,
  type FollowMethod,
  type TaskStatus,
} from '@/lib/constants';
import { fromPostgresError, notFound } from '@/lib/errors';
import { todayInJst } from '@/lib/format';
import type { SupabaseServerClient } from '@/lib/supabase/server';
import { isUuid } from '@/lib/uuid';

interface TaskRow {
  id: string;
  title: string;
  due_date: string;
  status: TaskStatus;
  display_order: number;
}

interface FollowRow {
  id: string;
  method: FollowMethod;
  note: string | null;
  followed_at: string;
  user_profiles: { display_name: string } | null;
}

interface CommRow {
  id: string;
  channel: string;
  direction: string;
  source: string;
  summary: string;
  occurred_at: string;
}

/** 表示・記録・AI入力は、同じ必須データの取得に成功した場合だけ作る。 */
export async function loadMeetingSheet(supabase: SupabaseServerClient, caseId: string) {
  if (!isUuid(caseId)) throw notFound();
  const caseResult = await supabase
    .from('wedding_cases')
    .select(
      'id, case_code, wedding_date, venue_room, guest_count, plan_types ( name ), user_profiles ( display_name )',
    )
    .eq('id', caseId)
    .maybeSingle();
  if (caseResult.error) throw fromPostgresError(caseResult.error);
  if (!caseResult.data) throw notFound();
  const target = caseResult.data as unknown as {
    id: string;
    case_code: string;
    wedding_date: string;
    venue_room: string | null;
    guest_count: number | null;
    plan_types: { name: string } | null;
    user_profiles: { display_name: string } | null;
  };

  const [profiles, tasks, follows, comms, sheets] = await Promise.all([
    supabase.from('couple_profiles').select(COUPLE_PROFILE_COLUMNS).eq('case_id', caseId),
    supabase
      .from('case_tasks')
      .select('id, title, due_date, status, display_order')
      .eq('case_id', caseId)
      .order('due_date')
      .order('display_order')
      .order('id'),
    supabase
      .from('follow_logs')
      .select('id, method, note, followed_at, user_profiles ( display_name )')
      .eq('case_id', caseId)
      .order('followed_at', { ascending: false })
      .limit(10),
    supabase
      .from('communication_logs')
      .select('id, channel, direction, source, summary, occurred_at')
      .eq('case_id', caseId)
      .order('occurred_at', { ascending: false })
      .limit(15),
    supabase
      .from('meeting_sheets')
      .select('id, generated_at')
      .eq('case_id', caseId)
      .order('generated_at', { ascending: false })
      .limit(1),
  ]);
  for (const result of [profiles, tasks, follows, comms, sheets]) {
    if (result.error) throw fromPostgresError(result.error);
  }

  const taskRows = (tasks.data ?? []) as TaskRow[];
  const done = taskRows.filter((task) => !INCOMPLETE_TASK_STATUSES.includes(task.status));
  const pending = taskRows.filter((task) => INCOMPLETE_TASK_STATUSES.includes(task.status));
  const today = todayInJst();
  return {
    target,
    profiles: (profiles.data ?? []) as unknown as {
      full_name: string | null;
      is_primary_contact: boolean;
    }[],
    taskRows,
    done,
    pending,
    followRows: (follows.data ?? []) as unknown as FollowRow[],
    commRows: (comms.data ?? []) as unknown as CommRow[],
    lastSheet: ((sheets.data ?? []) as { generated_at: string }[])[0] ?? null,
    today,
    summary: {
      caseCode: target.case_code,
      generatedFor: today,
      totalTasks: taskRows.length,
      doneTasks: done.length,
      pendingTasks: pending.map((task) => ({
        title: task.title,
        dueDate: task.due_date,
        status: task.status,
      })),
    },
  };
}
