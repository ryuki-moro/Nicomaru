/**
 * 共通モーダル（Issue #206）。
 *
 * 画面ごとにモーダルを作ると、見た目・キーボード操作・閉じ方がぶれる。ここに1つにまとめ、
 * どの画面でも次の動きになるようにする。土台はブラウザ標準の <dialog>（showModal）で、
 * 背面の操作不可・読み上げの「ダイアログ」扱いは標準の挙動に任せる。
 *
 *   - 開く   … open が true になったら showModal() で開く。フォーカスは initialFocusRef へ移す。
 *              指定が無ければダイアログ自身へ移し、見出し（labelledBy）から読み上げさせる。
 *   - 閉じる … open が false になったら閉じ、フォーカスを returnFocusRef（開いたボタンなど）へ戻す。
 *   - Esc    … onClose を呼ぶ。onClose を渡さないモーダルは Esc では閉じない
 *              （閉じると二度と表示できない内容を、押し間違いで失わないため）。
 *   - 処理中 … busy のあいだは Esc でも閉じず、open が false になっても閉じるのを待つ
 *              （保存の結果が出る前に背面へ戻れてしまわないようにする）。
 *   - Tab    … モーダルの中の操作できる要素だけを順に巡る。
 */
'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface Props {
  open: boolean;
  /** モーダルの見出し要素の id（aria-labelledby）。見出しは children の中に置く */
  labelledBy: string;
  /** Esc で閉じるときに呼ぶ。渡さなければ Esc では閉じない */
  onClose?: () => void;
  /** 処理中。true のあいだは閉じない */
  busy?: boolean;
  /** 開いたときにフォーカスを置く要素。取り消し側のボタンを指定すると押し間違いが起きにくい */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 閉じたときにフォーカスを戻す要素 */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function Modal({
  open,
  labelledBy,
  onClose,
  busy = false,
  initialFocusRef,
  returnFocusRef,
  children,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
      // 開いた直後に加え、フォーカスがモーダルの中の操作要素に無いあいだは置き直す。
      // 開いた瞬間に対象のボタンが処理中で無効だと focus() が効かないため、busy が変わったときにも試す。
      const active = document.activeElement;
      if (!wasOpen.current || active === dialog || !dialog.contains(active)) {
        (initialFocusRef?.current ?? dialog).focus();
      }
      wasOpen.current = true;
      return;
    }

    if (busy) return;
    if (dialog.open) dialog.close();
    if (wasOpen.current) {
      wasOpen.current = false;
      returnFocusRef?.current?.focus();
    }
  }, [open, busy, initialFocusRef, returnFocusRef]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (targets.length === 0) return;
        const current = targets.findIndex((target) => target === document.activeElement);
        const next =
          current < 0
            ? event.shiftKey
              ? targets.length - 1
              : 0
            : (current + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
        targets[next]?.focus();
      }}
      onCancel={(event) => {
        // 既定の「Esc で閉じる」は止め、閉じるかどうかは open を持つ呼び出し側に決めさせる
        event.preventDefault();
        if (!busy) onClose?.();
      }}
      className="fixed inset-0 z-50 m-0 h-full max-h-none w-full max-w-none overflow-y-auto border-0 bg-transparent p-4 backdrop:bg-text-primary/40 focus:outline-none"
    >
      {open && <div className="card mx-auto mt-8 w-full max-w-2xl space-y-4">{children}</div>}
    </dialog>
  );
}
