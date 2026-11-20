'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * 画面の操作を止めて表示するモーダル。表示している間だけ描画する（`{open && <ModalDialog …>}`）。
 *
 * ネイティブの <dialog> を showModal() で開くので、フォーカスの移動・背面の操作不可（inert）・
 * 閉じたあとに元のボタンへフォーカスを戻す処理はブラウザに任せる。role="dialog" や
 * aria-modal、自前のフォーカス閉じ込めは足さない。
 *
 * onClose を渡すと Esc やスマホの戻る操作で閉じられる。渡さない場合は閉じる操作を画面側の
 * ボタンだけに限る（一度しか表示できない招待URLなど、うっかり閉じると取り戻せない内容向け）。
 */
export function ModalDialog({
  children,
  labelledBy,
  label,
  onClose,
}: {
  children: ReactNode;
  /** 見出しの id。見出しが無いときは label を使う */
  labelledBy?: string;
  label?: string;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const dismissible = onClose !== undefined;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // 閉じる処理は書かない。要素がDOMから外れれば最前面（top layer）からも外れる。
    // ここで close() すると StrictMode の再実行で close イベントが出て onClose が走ってしまう
    if (!dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      // closedby は未対応のブラウザでは無視される。onCancel／onClose が代わりを務める
      {...({ closedby: dismissible ? 'closerequest' : 'none' } as Record<string, string>)}
      onCancel={(event) => {
        if (!dismissible) event.preventDefault();
      }}
      onClose={(event) => {
        if (dismissible) {
          onClose();
          return;
        }
        // Esc を連打すると cancel を止められずに閉じるブラウザがある。内容を失わないよう開き直す
        const dialog = event.currentTarget;
        if (dialog.isConnected && !dialog.open) dialog.showModal();
      }}
      className="m-0 h-full max-h-none w-full max-w-none overflow-y-auto border-0 bg-transparent p-4 backdrop:bg-text-primary/40"
    >
      {children}
    </dialog>
  );
}
