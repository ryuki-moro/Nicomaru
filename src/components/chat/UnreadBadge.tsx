/** チャットの未読件数。0件のときは何も出さない。 */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="badge-danger ml-2 px-2 py-0" role="img" aria-label={`未読${count}件`}>
      {count > 99 ? '99+' : count}
    </span>
  );
}
