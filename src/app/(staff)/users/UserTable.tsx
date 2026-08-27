/**
 * U01 利用者一覧の表部分。
 *
 * 正本: 基本設計書 Version 1.2 4-3「U01：検索キーワード。一覧（氏名・メール・種別・状態）」。
 * 対話要素が無いため Server Component のまま置き、クライアントへ JS を送らない。
 * 状態の表示名は表6-9（USER_STATUS_LABEL）を単一ソースとする（12-2）。
 */
import Link from 'next/link';

import { EmptyState } from '@/components/ui/EmptyState';
import {
  ROLE_LABEL,
  USER_STATUS_LABEL,
  type Role,
  type UserStatus,
} from '@/lib/constants';

export interface UserListRow {
  id: string;
  displayName: string;
  email: string;
  role: Role;
  status: UserStatus;
  venueName: string | null;
}

const STATUS_TONE: Record<UserStatus, string> = {
  active: 'badge-success',
  invited: 'badge-warning',
  suspended: 'badge-danger',
  deleted: 'badge-neutral',
};

export function UserTable({
  rows,
  showVenue,
  currentUserId,
}: {
  rows: UserListRow[];
  /** system_admin は式場をまたぐため所属列を出す（U01） */
  showVenue: boolean;
  currentUserId: string;
}) {
  if (rows.length === 0) {
    return <EmptyState message="該当する利用者が見つかりませんでした。" />;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">氏名</th>
            <th scope="col">メールアドレス</th>
            {showVenue && <th scope="col">所属式場</th>}
            <th scope="col">利用者種別</th>
            <th scope="col">状態</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <Link href={`/users/${row.id}`} className="text-link hover:underline">
                  {row.displayName}
                </Link>
                {row.id === currentUserId && (
                  <span className="ml-2 badge-neutral">ご自身</span>
                )}
              </td>
              <td className="break-all">{row.email}</td>
              {showVenue && (
                <td className={row.venueName ? undefined : 'text-text-muted'}>
                  {row.venueName ?? '未設定'}
                </td>
              )}
              <td>{ROLE_LABEL[row.role]}</td>
              <td>
                <span className={STATUS_TONE[row.status]}>{USER_STATUS_LABEL[row.status]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
