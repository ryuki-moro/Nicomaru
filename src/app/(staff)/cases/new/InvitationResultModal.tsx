'use client';

/**
 * K03 登録完了モーダル（4-3 K03）。
 *
 * 新郎・新婦それぞれの招待URLを表示し、「コピー」「メールで送信」「LINEで送信」を提供する。
 * 送付実体は Resend／LINE Messaging API であり、プランナーは送信操作のみを行う。
 *
 * 平文トークンは保存しないため（6-3-6）、このモーダルを閉じるとURLは再表示できない。
 * 「メールで送信」「LINEで送信」も再発行を伴うため、押すたびに表示中のURLは失効し、
 * 新しく発行されたURLに置き換わる。取り違えを防ぐため、応答のURLで必ず表示を更新する。
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { ApiCallError, api } from '@/lib/api/client';
import {
  CONTACT_CHANNELS,
  CONTACT_CHANNEL_LABEL,
  PARTNER_ROLE_LABEL,
  type ContactChannel,
  type PartnerRole,
} from '@/lib/constants';

export interface IssuedInvitation {
  id: string;
  targetPartnerRole: PartnerRole;
  channel: ContactChannel;
  expiresAt: string;
  url: string;
}

interface SendResponse {
  id: string;
  url: string;
  expiresAt: string;
  sentAt: string | null;
  delivered: boolean;
  skippedReason: string | null;
}

interface Props {
  caseId: string;
  caseCode: string;
  invitations: IssuedInvitation[];
  assignedCount: number;
  assignError: string | null;
}

const formatDateTime = (value: string) => value.slice(0, 10).replaceAll('-', '/');

export function InvitationResultModal({
  caseId,
  caseCode,
  invitations,
  assignedCount,
  assignError,
}: Props) {
  const router = useRouter();
  const [items, setItems] = useState(
    invitations.map((invitation) => ({ ...invitation, note: null as string | null })),
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  async function copy(id: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNote(id, 'コピーしました。');
    } catch {
      // クリップボードが使えない環境（権限拒否・非セキュアコンテキスト）でも操作を止めない
      setNote(id, 'コピーできませんでした。URLを選択して手動でコピーしてください。');
    }
  }

  function setNote(id: string, note: string | null) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, note } : item)));
  }

  async function send(id: string, channel: ContactChannel) {
    if (busyId) return;
    setBusyId(id);
    try {
      const result = await api.post<SendResponse>(
        `/api/cases/${caseId}/invitations/${id}/send`,
        { channel },
      );
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                // 送信は再発行を伴うため、行のIDとURLごと差し替える（6-3-6）
                id: result.id,
                url: result.url,
                expiresAt: result.expiresAt,
                channel,
                note: result.delivered
                  ? `${CONTACT_CHANNEL_LABEL[channel]}で送信しました。`
                  : (result.skippedReason ?? '送信は行われませんでした。')
                    + ' 新しいURLを発行しましたので、表示中のURLをお使いください。',
              }
            : item,
        ),
      );
    } catch (error) {
      setNote(
        id,
        error instanceof ApiCallError
          ? error.message
          : '送信に失敗しました。時間をおいてもう一度お試しください。',
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="invitation-result-title"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-text-primary/40 p-4"
    >
      <div className="card mt-8 w-full max-w-2xl space-y-4">
        <div>
          <h2 id="invitation-result-title" className="section-head">
            案件を登録しました
          </h2>
          <p className="mt-1 text-label text-text-secondary">
            案件番号は <span className="font-medium">{caseCode}</span> です。
          </p>
        </div>

        {assignError ? (
          <div role="alert" className="banner-error">
            <span>
              {assignError}
              　案件詳細画面から宿題の割り当てをやり直せます。
            </span>
          </div>
        ) : (
          <div className="banner-info">
            <span>宿題を{assignedCount}件割り当て、準備タイムラインを作成しました。</span>
          </div>
        )}

        <div className="banner-info">
          <span>
            招待URLはこの画面でのみ確認できます。閉じたあとは、案件詳細の招待状況から
            新しいURLを発行してご案内ください。
          </span>
        </div>

        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id} className="rounded-card border border-border-light p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-label font-medium">
                  {PARTNER_ROLE_LABEL[item.targetPartnerRole]}
                </span>
                <span className="text-caption text-text-muted">
                  有効期限 {formatDateTime(item.expiresAt)}
                </span>
              </div>

              <input
                readOnly
                value={item.url}
                aria-label={`${PARTNER_ROLE_LABEL[item.targetPartnerRole]}の招待URL`}
                className="field mb-2 font-mono text-caption"
                onFocus={(e) => e.currentTarget.select()}
              />

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary w-auto px-4 py-2"
                  onClick={() => copy(item.id, item.url)}
                >
                  コピー
                </button>
                {CONTACT_CHANNELS.map((channel) => (
                  <button
                    key={channel}
                    type="button"
                    className="btn-secondary w-auto px-4 py-2"
                    disabled={busyId !== null}
                    onClick={() => send(item.id, channel)}
                  >
                    {CONTACT_CHANNEL_LABEL[channel]}で送信
                  </button>
                ))}
              </div>

              {item.note && <p className="mt-2 text-caption text-text-secondary">{item.note}</p>}
            </li>
          ))}
        </ul>

        <button type="button" className="btn-primary" onClick={() => router.push('/cases')}>
          閉じて案件一覧へ
        </button>
      </div>
    </div>
  );
}
