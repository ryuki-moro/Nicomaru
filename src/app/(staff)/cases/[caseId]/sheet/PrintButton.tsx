'use client';

/**
 * 打ち合わせ前準備シートの印刷（D03、6-11）。
 *
 * 6-11 は出力の第一手段をブラウザ印刷（印刷用CSS）と定めている。
 * 印刷ダイアログから「PDFとして保存」を選べるため、
 * Vercel Hobby のバンドルサイズ・実行時間の制約（2-2-1）を増やさずに PDF も得られる。
 */
export function PrintButton() {
  return (
    <button type="button" className="btn-primary w-auto px-5" onClick={() => window.print()}>
      印刷する
    </button>
  );
}
