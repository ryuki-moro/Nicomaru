/**
 * APIエラーのサマリ表示（4-3 エラー表示規約）。
 *   入力検証エラーは該当項目の直下に、APIエラーはフォーム上部にサマリとして表示する。
 */
export function ErrorSummary({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="banner-error mb-3">
      <span>{message}</span>
    </div>
  );
}

/** 項目直下のエラー文言。 */
export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="field-error">{message}</p>;
}
