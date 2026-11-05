import { beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { PlanTypeForm, type SavePlanTypeResult } from '@/app/(staff)/plan-types/PlanTypeForm';

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: vi.fn(),
}));

const states: { initial: unknown; set: ReturnType<typeof vi.fn> }[] = [];
beforeEach(() => {
  states.length = 0;
  vi.clearAllMocks();
  vi.mocked(React.useState).mockImplementation(((initial: unknown) => {
    const value = typeof initial === 'function' ? initial() : initial;
    const set = vi.fn();
    states.push({ initial: value, set });
    return [value, set];
  }) as unknown as typeof React.useState);
});

function submitForm(save: (values: unknown) => Promise<SavePlanTypeResult>) {
  const tree = PlanTypeForm({
    mode: 'new',
    initial: {
      name: '模擬プラン',
      description: '',
      defaultGuestCountMin: '',
      defaultGuestCountMax: '',
      displayOrder: '0',
      active: true,
      assignments: [{ taskTemplateId: 'template-1', displayOrder: 0, dueOffsetDaysOverride: null }],
    },
    templates: [{ id: 'template-1', name: '模擬宿題', dueOffsetDays: 7, active: true }],
    save,
  });
  return tree.props.onSubmit as (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
}
const event = () => ({ preventDefault: vi.fn() }) as unknown as React.FormEvent<HTMLFormElement>;

it('保存失敗後に状態を解除し同じ内容で再試行できる', async () => {
  const save = vi
    .fn<(values: unknown) => Promise<SavePlanTypeResult>>()
    .mockRejectedValueOnce(new Error('internal'))
    .mockResolvedValueOnce({ ok: true, id: 'plan-1' });
  const submit = submitForm(save);
  await submit(event());
  expect(states.find((s) => s.initial === false)!.set.mock.calls.map(([value]) => value)).toEqual([
    true,
    false,
  ]);
  expect(states.find((s) => s.initial === null)!.set).toHaveBeenLastCalledWith(
    '保存に失敗しました。時間をおいて再度お試しください。',
  );
  expect(push).not.toHaveBeenCalled();
  await submit(event());
  expect(save.mock.calls[1]![0]).toEqual(save.mock.calls[0]![0]);
  expect(push).toHaveBeenCalledWith('/plan-types');
  expect(refresh).toHaveBeenCalled();
});

it.each([
  ['FORBIDDEN', '/error?code=403'],
  ['NOT_FOUND', '/error?code=404'],
] as const)('%s の遷移を維持する', async (code, path) => {
  const submit = submitForm(
    vi.fn().mockResolvedValue({ ok: false, code, message: 'error', details: [] }),
  );
  await submit(event());
  expect(push).toHaveBeenCalledWith(path);
  expect(states.find((s) => s.initial === false)!.set).toHaveBeenLastCalledWith(false);
});

it('業務エラーを表示する', async () => {
  const submit = submitForm(
    vi.fn().mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: '入力を確認してください',
      details: [{ field: 'name', reason: '名前を確認してください' }],
    }),
  );
  await submit(event());
  expect(states.find((s) => s.initial === null)!.set).toHaveBeenLastCalledWith(
    '入力を確認してください',
  );
  expect(
    states.find(
      (s) =>
        typeof s.initial === 'object' && s.initial !== null && Object.keys(s.initial).length === 0,
    )!.set,
  ).toHaveBeenLastCalledWith({ name: '名前を確認してください' });
});
