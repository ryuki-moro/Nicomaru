import { describe, expect, it } from 'vitest';

import {
  submittedListHref,
  taskBackHref,
  taskDetailHref,
} from '@/app/(couple)/mypage/tasks/taskLinks';
import { homeCrumbFor } from '@/components/layout/breadcrumbItems';
import { isCoupleNavActive } from '@/components/couple/coupleNavActive';

const TASK_ID = '00000000-0000-4000-8000-000000000001';

describe('宿題詳細（M03）の戻り先', () => {
  it('入口を from に載せる。宿題一覧からは付けない', () => {
    expect(taskDetailHref(TASK_ID)).toBe(`/mypage/tasks/${TASK_ID}`);
    expect(taskDetailHref(TASK_ID, 'home')).toBe(`/mypage/tasks/${TASK_ID}?from=home`);
    expect(taskDetailHref(TASK_ID, 'timeline')).toBe(`/mypage/tasks/${TASK_ID}?from=timeline`);
  });

  it('「戻る」は来た画面へ。from がなければ宿題一覧', () => {
    expect(taskBackHref('home')).toBe('/mypage');
    expect(taskBackHref('timeline')).toBe('/mypage/timeline');
    expect(taskBackHref(undefined)).toBe('/mypage/tasks');
  });

  it.each([
    'https://evil.example.test',
    '//evil.example.test',
    '/mypage/account',
    'toString',
    '__proto__',
  ])('決まったキー以外（%s）は宿題一覧へ寄せる', (from) => {
    expect(taskBackHref(from)).toBe('/mypage/tasks');
  });

  it('from が複数あるときは宿題一覧へ寄せる', () => {
    expect(taskBackHref(['home', 'timeline'])).toBe('/mypage/tasks');
  });

  it('提出後は、提出した宿題の ID だけを付けて一覧へ戻る', () => {
    expect(submittedListHref(TASK_ID)).toBe(`/mypage/tasks?submitted=${TASK_ID}`);
  });
});

describe('新郎新婦の下部ナビの現在地', () => {
  const home = { href: '/mypage', children: ['/mypage/notifications'] };
  const tasks = { href: '/mypage/tasks' };

  it('ホームは /mypage と子画面（お知らせ）だけで現在地になる', () => {
    expect(isCoupleNavActive(home, '/mypage')).toBe(true);
    expect(isCoupleNavActive(home, '/mypage/notifications')).toBe(true);
    expect(isCoupleNavActive(home, '/mypage/tasks')).toBe(false);
  });

  it('宿題は配下の詳細でも現在地になるが、名前が似た別のパスには当たらない', () => {
    expect(isCoupleNavActive(tasks, '/mypage/tasks')).toBe(true);
    expect(isCoupleNavActive(tasks, `/mypage/tasks/${TASK_ID}`)).toBe(true);
    expect(isCoupleNavActive(tasks, '/mypage/tasksx')).toBe(false);
  });
});

describe('プランナー側のパンくずの起点', () => {
  it('ロールの着地点から始める', () => {
    expect(homeCrumbFor('planner')).toEqual({ label: 'ダッシュボード', href: '/dashboard' });
    expect(homeCrumbFor('admin')).toEqual({ label: 'ダッシュボード', href: '/dashboard' });
    expect(homeCrumbFor('system_admin')).toEqual({ label: '利用状況', href: '/system' });
  });
});
