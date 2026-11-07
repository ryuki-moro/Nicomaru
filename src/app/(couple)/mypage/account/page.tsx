import { requirePageUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await requirePageUser();

  return (
    <div className="space-y-5">
      <h1 className="section-head">アカウント</h1>

      <section className="card space-y-2">
        <h2 className="text-label font-bold text-text-primary">ご登録の内容</h2>
        <dl className="space-y-2 text-label">
          <div>
            <dt className="text-caption text-text-muted">お名前</dt>
            <dd>{user.displayName}</dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">メールアドレス</dt>
            <dd>{user.email}</dd>
          </div>
        </dl>
        <p className="text-caption text-text-muted">
          ご登録内容の変更は、担当プランナーへお知らせください。
        </p>
      </section>
    </div>
  );
}
