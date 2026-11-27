/**
 * T01 の 9-10 テンプレート案パネル（Phase 3拡張、Issue #118）。
 *
 * 既存テンプレートの実データから、標準的な準備項目の不足分をルールで案にする。
 * 案はその場で編集でき、登録は既存の「新規登録」（T02）導線を通す（ここでは保存しない、7-1）。
 * 案件単位の AI ジョブ版は案件詳細（K02）のパネルで扱う。
 */
'use client';

import { useMemo, useState } from 'react';

import { AiHeading } from '@/components/ai/AiNotice';
import { buildTemplateDraft } from '@/lib/ai/template-draft';

interface Props {
  existing: { name: string; due_offset_days: number }[];
}

export function TemplateDraftPanel({ existing }: Props) {
  const draft = useMemo(() => buildTemplateDraft({ existing }), [existing]);
  const [rows, setRows] = useState(draft.templates);
  if (draft.templates.length === 0) return null;
  return (
    <section className="card">
      <AiHeading note="まだ登録していない標準的なやることの案です。内容を直してから「この内容で登録へ」で登録画面に進んでください（自動では登録しません）。">
        やることの案（要確認）
      </AiHeading>
      <div className="table-wrap mt-2">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">やることの名前（案）</th>
              <th scope="col">説明</th>
              <th scope="col">逆算日数</th>
              <th scope="col">登録</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={t.name}>
                <td>
                  <input
                    className="field"
                    aria-label="やることの名前"
                    value={t.name}
                    onChange={(e) =>
                      setRows(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
                    }
                  />
                </td>
                <td>
                  <input
                    className="field"
                    aria-label="説明"
                    value={t.description}
                    onChange={(e) =>
                      setRows(
                        rows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)),
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    className="field w-24"
                    type="number"
                    min={0}
                    aria-label="逆算日数"
                    value={t.due_offset_days}
                    onChange={(e) =>
                      setRows(
                        rows.map((r, j) =>
                          j === i ? { ...r, due_offset_days: Number(e.target.value) } : r,
                        ),
                      )
                    }
                  />
                </td>
                <td>
                  {/* 直した内容を登録画面へ引き継ぐ。ここでは保存しない（7-1） */}
                  <a
                    className="btn-ghost whitespace-nowrap"
                    href={`/templates/new?${new URLSearchParams({
                      name: t.name,
                      description: t.description,
                      dueOffsetDays: String(t.due_offset_days),
                    })}`}
                  >
                    この内容で登録へ
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-caption text-text-muted">
        案はルールで生成しています。AIワーカーが動いている環境では、案件詳細から AI
        ジョブとして作り直すこともできます。
      </p>
    </section>
  );
}
