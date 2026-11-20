/**
 * M03 確認済の宿題の表示。
 *
 * 確認済でも入力欄と「提出する」が出ていると、まだ出していないように見える。
 * そこで最初は回答を読み取り表示にし、「内容を変更する」を押したときだけ提出フォーム（children）を出す。
 * 変更後の受理可否はこれまでどおりサーバー側（/api/tasks/{taskId}/submit）が決める。
 */
'use client';

import { useState, type ReactNode } from 'react';

import Link from 'next/link';

interface Props {
  /** 読み取り表示する回答。値が無い項目は呼び出し側で除く */
  items: readonly { label: string; value: string }[];
  /** 「戻る」の行き先。M03 へ入ってきた画面（taskBackHref） */
  backHref: string;
  /** 確認のみの宿題は変える内容が無いので、変更ボタンを出さない */
  canChange: boolean;
  /** 「内容を変更する」を押したあとに出す提出フォーム */
  children: ReactNode;
}

export function ConfirmedAnswer({ items, backHref, canChange, children }: Props) {
  const [editing, setEditing] = useState(false);
  if (editing) return <>{children}</>;

  return (
    <div className="flex flex-col gap-3">
      {items.length > 0 && (
        <dl className="card flex flex-col gap-3" aria-label="提出した内容">
          {items.map((item) => (
            <div key={item.label}>
              <dt className="text-label text-text-muted">{item.label}</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-base text-text-primary">
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-1 flex flex-col gap-[10px]">
        {canChange && (
          <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>
            内容を変更する
          </button>
        )}
        <Link href={backHref} className="btn-ghost self-center">
          戻る
        </Link>
      </div>
    </div>
  );
}
