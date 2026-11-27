import { requirePageUser } from '@/lib/auth/session';
import { CASE_WORK_ROLES } from '@/lib/constants';

/** 通知履歴は案件業務の画面。system_admin には開かせない（P04 へ送る）。 */
export default async function NotificationsLayout({ children }: { children: React.ReactNode }) {
  await requirePageUser(...CASE_WORK_ROLES);
  return children;
}
