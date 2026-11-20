'use client';

import { useState, type InputHTMLAttributes } from 'react';

/**
 * パスワード入力欄。入力した文字を確かめられるよう、欄の右端に「表示」ボタンを置く。
 *
 * - 既定は type="password"（ブラウザのパスワード保存・自動入力の対象にする）
 * - ボタンは aria-pressed で表示中かどうかを伝える。読み上げ名は固定し、状態は pressed で表す
 * - 貼り付けや自動入力は止めない
 */
export function PasswordInput({
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={`field pr-16 ${className}`}
      />
      <button
        type="button"
        aria-pressed={visible}
        aria-label="パスワードを表示"
        disabled={props.disabled}
        onClick={() => setVisible((current) => !current)}
        className="absolute inset-y-0 right-0 flex min-w-[44px] items-center justify-center rounded-r-field px-3 text-label text-link hover:underline disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:font-bold"
      >
        {/* 文言を「隠す」に変えると読み上げ名（パスワードを表示）と食い違うので固定し、
            押されている状態は aria-pressed と太字で示す */}
        表示
      </button>
    </div>
  );
}
