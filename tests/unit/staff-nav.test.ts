import { describe, expect, it } from 'vitest';

import {
  createdRoleLabelFor,
  staffNavItemsFor,
  usersLabelFor,
} from '@/components/layout/staffNavItems';

const labels = (role: Parameters<typeof staffNavItemsFor>[0]) =>
  staffNavItemsFor(role).map((item) => item.label);

describe('プランナー側のグローバルナビ', () => {
  it('planner には共通の4画面だけを出す', () => {
    expect(labels('planner')).toEqual(['ダッシュボード', '案件一覧', '提出物確認', '通知履歴']);
  });

  it('admin には式場内の管理画面を足す', () => {
    expect(labels('admin')).toEqual([
      'ダッシュボード',
      '案件一覧',
      '提出物確認',
      '通知履歴',
      '宿題テンプレート',
      'プラン種別',
      'プランナー管理',
    ]);
  });

  it('system_admin には S01〜S03 と利用者管理を足し、式場内の管理画面は出さない', () => {
    expect(labels('system_admin')).toEqual([
      'ダッシュボード',
      '案件一覧',
      '提出物確認',
      '通知履歴',
      '職員管理',
      '式場管理',
      '利用状況',
    ]);
  });

  it('利用者管理の名前と登録ボタンは、管理する相手に合わせる', () => {
    expect([usersLabelFor('system_admin'), createdRoleLabelFor('system_admin')]).toEqual([
      '職員管理',
      '式場管理者',
    ]);
    expect([usersLabelFor('admin'), createdRoleLabelFor('admin')]).toEqual([
      'プランナー管理',
      'プランナー',
    ]);
  });

  it('couple には何も出さない', () => {
    expect(labels('couple')).toEqual([]);
  });
});
