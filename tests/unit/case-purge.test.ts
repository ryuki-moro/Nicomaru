import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchFailure } from '@/lib/api/internal';
import { purgeCases } from '@/lib/batches/case-purge';

const { adminFactory } = vi.hoisted(() => ({ adminFactory: vi.fn() }));
vi.mock('@/lib/supabase/admin', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/admin')>(),
  createSupabaseAdminClient: adminFactory,
}));

const NOW = Date.parse('2026-10-09T00:00:00.000Z');
const CUTOFF = new Date(NOW - 180 * 86_400_000).toISOString();
const OLD = new Date(Date.parse(CUTOFF) - 1).toISOString();
const PRIVATE_ERROR = 'private@example.test / private-file.pdf';
type Row = Record<string, unknown>;
type Call = { method: string; table: string; url: URL; body: Row };
type FailureMode = 'database' | 'transport';

// Use the real Supabase builders against an in-memory HTTP fixture. There is no
// fallback to global fetch, so these destructive tests cannot contact a database.
function fixture() {
  const rows: Record<string, Row[]> = {};
  const objects = new Set<string>();
  const calls: Call[] = [];
  let fail: (call: Call) => FailureMode | undefined = () => undefined;
  const matches = (row: Row, params: URLSearchParams) => [...params].every(([key, filter]) => {
    if (['select', 'order', 'limit', 'offset'].includes(key)) return true;
    const value = row[key];
    if (filter === 'not.is.null') return value !== null && value !== undefined;
    if (filter.startsWith('eq.')) return String(value) === filter.slice(3);
    if (filter.startsWith('gt.')) return String(value) > filter.slice(3);
    if (filter.startsWith('lt.')) return value !== null && value !== undefined && String(value) < filter.slice(3);
    if (filter.startsWith('in.(')) return filter.slice(4, -1).split(',').includes(String(value));
    throw new Error(`Unexpected filter: ${key}=${filter}`);
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe('https://purge-fixture.example.test');
    const bodyText = request.method === 'GET' ? '' : await request.text();
    const body = bodyText ? JSON.parse(bodyText) as Row : {};
    const table = url.pathname.startsWith('/storage/') ? 'storage-object' : url.pathname.split('/').at(-1)!;
    const call = { method: request.method, table, url, body };
    calls.push(call);
    if (calls.length > 12_000) throw new Error('Pagination did not terminate');
    const failure = fail(call);
    if (failure === 'transport') throw new TypeError(PRIVATE_ERROR);
    if (failure === 'database') return Response.json({ message: PRIVATE_ERROR, code: 'TEST', statusCode: '400' }, { status: 400 });
    if (table === 'storage-object') {
      const bucket = url.pathname.split('/').at(-1)!;
      for (const path of body.prefixes as string[]) objects.delete(`${bucket}/${path}`);
      return Response.json([]);
    }
    if (table === 'purge_ai_job_payloads') {
      return Response.json([{ payloads_cleared: 3, rows_deleted: 2 }]);
    }
    if (table === 'batch_runs') return Response.json({ id: 'run-id' });
    const all = rows[table] ?? [];
    const selected = all.filter((row) => matches(row, url.searchParams));
    if (request.method === 'GET') {
      if (url.searchParams.get('order')?.startsWith('id.asc')) selected.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      // Simulate the server cap too, so missing pagination cannot pass by accident.
      return Response.json(selected.slice(0, Math.min(Number(url.searchParams.get('limit') ?? 200), 200)));
    }
    if (request.method === 'DELETE') rows[table] = all.filter((row) => !selected.includes(row));
    else if (request.method === 'PATCH') for (const row of selected) Object.assign(row, body);
    else throw new Error(`Unexpected request: ${request.method} ${table}`);
    return new Response(null, { status: 204 });
  });
  const admin = createClient('https://purge-fixture.example.test', 'fixture-only-key', {
    auth: { autoRefreshToken: false, persistSession: false }, db: { retry: false }, global: { fetch },
  });
  const add = (table: string, row: Row) => { (rows[table] ??= []).push(row); };
  const addCase = (id: string, archivedAt: string | null = OLD) => {
    add('wedding_cases', { id, venue_id: `venue-${id}`, archived_at: archivedAt });
    add('couple_profiles', { id: `profile-${id}`, case_id: id, full_name: '個人名', kana: 'コジンメイ', email: PRIVATE_ERROR, email_hash: 'hash', phone: 'phone', address: '住所', memo: 'private' });
    add('case_invitations', { id: `invite-${id}`, case_id: id, recipient_email: PRIVATE_ERROR, recipient_email_hash: 'hash' });
  };
  const addFile = (caseId: string, id: string) => {
    const objectPath = `${caseId}/${id}.pdf`;
    add('storage_files', { id, case_id: caseId, bucket: 'private', object_path: objectPath });
    objects.add(`private/${objectPath}`);
  };
  return { admin, rows, calls, objects, add, addCase, addFile, failWith: (handler: typeof fail) => { fail = handler; } };
}

async function failureOf(promise: Promise<unknown>): Promise<BatchFailure> {
  const error = await promise.then(() => { throw new Error('Expected batch failure'); }, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(BatchFailure);
  expect(String(error)).not.toContain(PRIVATE_ERROR);
  expect(JSON.stringify(error)).not.toContain(PRIVATE_ERROR);
  return error as BatchFailure;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('External requests are forbidden')));
  adminFactory.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('案件削除バッチの保持期間・ページング', () => {
  it('180日を超えた案件だけ匿名化し、境界・未経過・未アーカイブを保持する', async () => {
    const f = fixture();
    f.addCase('old');
    f.addCase('boundary', CUTOFF);
    f.addCase('recent', new Date(Date.parse(CUTOFF) + 1).toISOString());
    f.addCase('active', null);
    for (const id of ['old', 'boundary', 'recent', 'active']) {
      f.addFile(id, `file-${id}`);
      f.add('case_guests', { id: `guest-${id}`, case_id: id });
    }
    f.add('audit_logs', { id: 'audit', case_id: 'old' });
    f.add('notification_logs', { id: 'notification', case_id: 'old' });
    const result = await purgeCases(f.admin);
    expect(result).toMatchObject({ targetCount: 1, detail: { filesRemoved: 1, failedCount: 0, retentionDays: 180, aiPayloadsCleared: 3, aiRowsDeleted: 2, targetScanFailed: false, aiRetentionSucceeded: true } });
    expect(f.rows.couple_profiles.find((row) => row.case_id === 'old')).toMatchObject({ full_name: '（削除済み）', kana: null, email: null, email_hash: null, phone: null, address: null, memo: null });
    expect(f.rows.case_invitations.find((row) => row.case_id === 'old')).toMatchObject({ recipient_email: null, recipient_email_hash: null });
    expect(f.rows.couple_profiles.filter((row) => row.full_name === '個人名')).toHaveLength(3);
    expect(f.rows.storage_files).toHaveLength(3);
    expect(f.rows.case_guests).toHaveLength(3);
    expect(f.rows.wedding_cases).toHaveLength(4);
    expect(f.rows.audit_logs).toHaveLength(1);
    expect(f.rows.notification_logs).toHaveLength(1);
    expect(f.calls.filter((call) => call.method !== 'GET').every((call) => !['audit_logs', 'notification_logs', 'wedding_cases'].includes(call.table))).toBe(true);
    expect(f.calls.find((call) => call.table === 'purge_ai_job_payloads')?.body).toEqual({ p_payload_days: 30, p_row_days: 90 });
  });

  it('200件を超える案件をID順に進み、201件目も処理する', async () => {
    const f = fixture();
    for (let i = 201; i > 0; i--) f.addCase(`case-${String(i).padStart(3, '0')}`);
    expect((await purgeCases(f.admin)).targetCount).toBe(201);
    expect(f.rows.couple_profiles.every((row) => row.email === null)).toBe(true);
    const scans = f.calls.filter((call) => call.table === 'wedding_cases');
    expect(scans.some((call) => call.url.searchParams.get('id') === 'gt.case-200')).toBe(true);
    expect(scans.every((call) => call.url.searchParams.get('order')?.startsWith('id.asc'))).toBe(true);
  });

  it('削除で行数が変わるファイルとタスクも201件目まで処理し、別案件には触れない', async () => {
    const f = fixture();
    f.addCase('old');
    f.addCase('active', null);
    f.addFile('active', 'keep');
    f.add('case_tasks', { id: 'keep', case_id: 'active' });
    f.add('task_submissions', { id: 'keep', case_task_id: 'keep' });
    for (let i = 201; i > 0; i--) {
      const id = String(i).padStart(3, '0');
      f.addFile('old', `file-${id}`);
      f.add('case_tasks', { id: `task-${id}`, case_id: 'old' });
      f.add('task_submissions', { id: `submission-${id}`, case_task_id: `task-${id}` });
    }
    expect(await purgeCases(f.admin)).toMatchObject({ targetCount: 1, detail: { filesRemoved: 201 } });
    expect(f.rows.storage_files).toEqual([expect.objectContaining({ id: 'keep' })]);
    expect(f.rows.task_submissions).toEqual([{ id: 'keep', case_task_id: 'keep' }]);
    expect(f.objects).toEqual(new Set(['private/active/keep.pdf']));
    const deletes = f.calls.filter((call) => call.table === 'storage_files' && call.method === 'DELETE');
    expect(deletes).toHaveLength(201);
    expect(deletes.every((call) => call.url.searchParams.get('case_id') === 'eq.old' && call.url.searchParams.has('id'))).toBe(true);
    expect(f.calls.some((call) => call.table === 'storage_files' && call.url.searchParams.get('id') === 'gt.file-200')).toBe(true);
    expect(f.calls.some((call) => call.table === 'case_tasks' && call.url.searchParams.get('id') === 'gt.task-200')).toBe(true);
  });
});

describe('案件削除バッチの失敗と再実行', () => {
  const operations = [
    ['storage_files', 'GET'], ['storage-object', 'DELETE'], ['storage_files', 'DELETE'],
    ['case_tasks', 'GET'], ['task_submissions', 'DELETE'], ['case_guests', 'DELETE'],
    ['communication_logs', 'DELETE'], ['meeting_notes', 'DELETE'], ['ai_jobs', 'DELETE'],
    ['meeting_sheets', 'DELETE'], ['follow_logs', 'DELETE'], ['couple_profiles', 'PATCH'], ['case_invitations', 'PATCH'],
  ];
  const operationFailures = operations.flatMap(([table, method]) =>
    (['database', 'transport'] as const).map((mode) => ({ table, method, mode })));
  it.each(operationFailures)('$table $methodの$mode失敗は成功件数に入れず、後続案件とAI整理は継続する', async ({ table, method, mode }) => {
    const f = fixture();
    f.addCase('case-1');
    f.addCase('case-2');
    f.addFile('case-1', 'file-1');
    f.add('case_tasks', { id: 'task-1', case_id: 'case-1' });
    let triggered = false;
    f.failWith((call) => {
      if (!triggered && call.table === table && call.method === method) { triggered = true; return mode; }
    });
    const error = await failureOf(purgeCases(f.admin));
    expect(triggered).toBe(true);
    expect(error.outcome).toMatchObject({ targetCount: 1, detail: { failedCount: 1, failures: [{ caseId: 'case-1', stage: expect.any(String) }], targetScanFailed: false, aiRetentionSucceeded: true } });
    expect(f.rows.couple_profiles.find((row) => row.case_id === 'case-2')?.email).toBeNull();
  });

  it.each<FailureMode>(['database', 'transport'])('Storageの%s失敗時は未削除ファイルの情報を保持し、再実行で回復する', async (mode) => {
    const f = fixture();
    f.addCase('case-1');
    f.addFile('case-1', 'file-1');
    f.addFile('case-1', 'file-2');
    f.failWith((call) => call.table === 'storage-object' && (call.body.prefixes as string[]).includes('case-1/file-2.pdf') ? mode : undefined);
    const error = await failureOf(purgeCases(f.admin));
    expect(error.outcome).toMatchObject({ targetCount: 0, detail: { filesRemoved: 1, failedCount: 1 } });
    expect(f.rows.storage_files).toEqual([expect.objectContaining({ id: 'file-2' })]);
    expect(f.objects).toEqual(new Set(['private/case-1/file-2.pdf']));
    expect(f.rows.couple_profiles[0].email).toBe(PRIVATE_ERROR);
    f.failWith(() => undefined);
    expect(await purgeCases(f.admin)).toMatchObject({ targetCount: 1, detail: { filesRemoved: 1, failedCount: 0 } });
    expect(f.rows.storage_files).toEqual([]);
    expect(f.objects.size).toBe(0);
  });

  it('Storage実体削除後のDB削除失敗でもメタ情報を残し、冪等な再実行で回復する', async () => {
    const f = fixture();
    f.addCase('case-1');
    f.addFile('case-1', 'file-1');
    f.failWith((call) => call.table === 'storage_files' && call.method === 'DELETE' ? 'database' : undefined);
    await failureOf(purgeCases(f.admin));
    expect(f.rows.storage_files).toHaveLength(1);
    expect(f.objects.size).toBe(0);
    f.failWith(() => undefined);
    expect((await purgeCases(f.admin)).targetCount).toBe(1);
    expect(f.rows.storage_files).toEqual([]);
  });

  it.each<FailureMode>(['database', 'transport'])('対象走査の%s失敗でもAI保持期間整理を試み、全体を失敗にする', async (mode) => {
    const f = fixture();
    f.failWith((call) => call.table === 'wedding_cases' ? mode : undefined);
    const error = await failureOf(purgeCases(f.admin));
    expect(error.outcome).toMatchObject({ targetCount: 0, detail: { targetScanFailed: true, aiRetentionSucceeded: true, aiPayloadsCleared: 3 } });
    expect(f.calls.some((call) => call.table === 'purge_ai_job_payloads')).toBe(true);
  });

  it('対象の2ページ目で走査に失敗しても完了済み200件を失敗記録に残す', async () => {
    const f = fixture();
    for (let i = 1; i <= 201; i++) f.addCase(`case-${String(i).padStart(3, '0')}`);
    f.failWith((call) => call.table === 'wedding_cases' && call.url.searchParams.has('id') ? 'database' : undefined);
    const error = await failureOf(purgeCases(f.admin));
    expect(error.outcome).toMatchObject({ targetCount: 200, detail: { targetScanFailed: true, aiRetentionSucceeded: true } });
    expect(f.rows.couple_profiles.find((row) => row.case_id === 'case-201')?.email).toBe(PRIVATE_ERROR);
  });

  it('ファイルの2ページ目で失敗しても残りのメタ情報を維持し、再実行で残件を削除する', async () => {
    const f = fixture();
    f.addCase('case-1');
    for (let i = 1; i <= 201; i++) f.addFile('case-1', `file-${String(i).padStart(3, '0')}`);
    f.failWith((call) => call.table === 'storage_files' && call.method === 'GET' && call.url.searchParams.has('id') ? 'database' : undefined);
    const error = await failureOf(purgeCases(f.admin));
    expect(error.outcome).toMatchObject({ targetCount: 0, detail: { filesRemoved: 200, failedCount: 1 } });
    expect(f.rows.storage_files).toEqual([expect.objectContaining({ id: 'file-201' })]);
    f.failWith(() => undefined);
    expect(await purgeCases(f.admin)).toMatchObject({ targetCount: 1, detail: { filesRemoved: 1 } });
    expect(f.rows.storage_files).toEqual([]);
  });

  it.each<FailureMode>(['database', 'transport'])('AI整理の%s失敗時も完了した案件数を保存する', async (mode) => {
    const f = fixture();
    f.addCase('case-1');
    f.failWith((call) => call.table === 'purge_ai_job_payloads' ? mode : undefined);
    const error = await failureOf(purgeCases(f.admin));
    expect(error.outcome).toMatchObject({ targetCount: 1, detail: { targetScanFailed: false, aiRetentionSucceeded: false, aiPayloadsCleared: 0, aiRowsDeleted: 0 } });
    expect(f.rows.couple_profiles[0].email).toBeNull();
  });

  it('失敗例は20件以内に抑え、失敗総数と対象の走査は省略しない', async () => {
    const f = fixture();
    for (let i = 0; i < 25; i++) f.addCase(`case-${String(i).padStart(3, '0')}`);
    f.failWith((call) => call.table === 'storage_files' ? 'database' : undefined);
    const error = await failureOf(purgeCases(f.admin));
    expect(error.outcome).toMatchObject({ targetCount: 0, detail: { failedCount: 25 } });
    expect(error.outcome.detail?.failures).toHaveLength(20);
  });

  it('内部認証を要求し、失敗はHTTP 500と実行記録に残し、上流PIIをログ・応答へ出さない', async () => {
    const f = fixture();
    f.addCase('case-1');
    f.failWith((call) => call.table === 'couple_profiles' ? 'database' : undefined);
    adminFactory.mockReturnValue(f.admin);
    vi.stubEnv('INTERNAL_CRON_SECRET', 'fixture-only-secret');
    const loggedError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loggedWarning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { POST } = await import('@/app/api/internal/case-purge/route');
    const unauthorized = await POST(new Request('https://app.example.test/api/internal/case-purge', { method: 'POST' }));
    expect(unauthorized.status).toBe(401);
    expect(adminFactory).not.toHaveBeenCalled();
    const response = await POST(new Request('https://app.example.test/api/internal/case-purge', { method: 'POST', headers: { 'x-internal-cron-secret': 'fixture-only-secret' } }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(PRIVATE_ERROR);
    expect(f.calls.find((call) => call.table === 'batch_runs' && call.method === 'PATCH')?.body).toMatchObject({ http_status: 500, target_count: 0, detail: { failedCount: 1 } });
    const logs = [...loggedError.mock.calls, ...loggedWarning.mock.calls].flat().map(String).join(' ');
    expect(logs).not.toContain(PRIVATE_ERROR);
    expect(JSON.stringify(f.calls.filter((call) => call.table === 'batch_runs').map((call) => call.body))).not.toContain(PRIVATE_ERROR);
  });
});
