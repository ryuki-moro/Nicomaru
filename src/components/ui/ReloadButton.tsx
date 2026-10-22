'use client';

export function ReloadButton() {
  return (
    <button type="button" className="text-link underline" onClick={() => window.location.reload()}>
      もう一度読み込む
    </button>
  );
}
