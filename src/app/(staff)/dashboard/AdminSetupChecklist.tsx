/**
 * D01 式場管理者の「準備の残り」。
 *
 * 案件を登録する前に必要な設定（やること・プラン・プランナー）が足りないときだけ出す。
 * すべて済んでいれば何も表示しない。
 */
import type { AppUser } from '@/lib/auth/session';
import { adminSetupD1 } from '@/lib/d1/admin';
import { localDB } from '@/lib/d1/runtime';
import Link from 'next/link';
import { ChevronRight } from './cards';

export async function AdminSetupChecklist({ user }: { user: AppUser }) {
  const setup = await adminSetupD1(await localDB(), user);
  const todos = [
    setup.templateCount === 0 && {
      href: '/templates',
      text: 'やることが登録されていません。新郎新婦に頼む準備を登録してください',
    },
    setup.planCount === 0 && {
      href: '/plan-types',
      text: 'プランが登録されていません。案件の登録にはプランが必要です',
    },
    setup.emptyPlanCount > 0 && {
      href: '/plan-types',
      text: `利用中のやることが1件も無いプランが${setup.emptyPlanCount}種類あります`,
    },
    setup.plannerCount === 0 && {
      href: '/users/new',
      text: '利用中のプランナーがいません。プランナーを登録してください',
    },
    setup.invitedCount > 0 && {
      href: '/users',
      text: `初回設定を待っているプランナーが${setup.invitedCount}人います`,
    },
  ].filter((todo): todo is { href: string; text: string } => Boolean(todo));
  if (todos.length === 0) return null;
  return (
    <section className="mt-5">
      <h2 className="section-head">準備の残り</h2>
      <ul className="mt-2 overflow-hidden rounded-card border border-border-light bg-surface">
        {todos.map((todo) => (
          <li key={todo.text} className="border-b border-border-light last:border-b-0">
            <Link
              href={todo.href}
              prefetch={false}
              className="flex items-center gap-3 px-4 py-3 text-label text-text-primary transition-colors hover:bg-field-filled-bg"
            >
              <span className="min-w-0 flex-1">{todo.text}</span>
              <ChevronRight />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
