import { requirePageUser } from '@/lib/auth/session';
import { CASE_WORK_ROLES } from '@/lib/constants';

/** 案件の一覧・詳細は案件業務の画面。system_admin には開かせない（P04 へ送る）。 */
export default async function CasesLayout({ children }: { children: React.ReactNode }) {
  await requirePageUser(...CASE_WORK_ROLES);
  return children;
}
