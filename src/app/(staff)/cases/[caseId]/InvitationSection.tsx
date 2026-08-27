'use client';

/**
 * K02 招待状況セクション（planner／admin のみ）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 K02／6-3-6「招待トークンの保存方式」。
 *   - 新郎・新婦それぞれの発行日時・送付チャネル・状態・有効期限・最終送信日時を表示する
 *   - 操作は「再発行して送信」（メール／LINE を選択）と「再発行してURLを表示」の2つ
 *   - 平文トークンは保存しないため、いずれの操作も既存の有効トークンを失効させて新規発行する
 *
 * 状態（未使用／使用済み／期限切れ／失効）の判定は invitations.ts の invitationState() が正本。
 * 同モジュールは node:crypto に依存するためクライアントから直接は読めない。
 * したがって本セクションは判定済みの一覧を GET /api/cases/{caseId}/invitations から取得する。
 */
import { useCallback, useEffect, useState } from 'react';

import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { InvitationStateBadge } from '@/components/ui/StatusBadge';
import { ApiCallError, api } from '@/lib/api/client';
import {
  CONTACT_CHANNELS,
  CONTACT_CHANNEL_LABEL,
  PARTNER_ROLE_LABEL,
  type ContactChannel,
  type InvitationState,
  type PartnerRole,
} from '@/lib/constants';

interface InvitationSummary {
  id: string;
  targetPartnerRole: PartnerRole;
  channel: ContactChannel;
  state: InvitationState;
  createdAt: string;
  expiresAt: string;
  lastSentAt: string | null;
}

interface IssueResponse {
  id: string;
  targetPartnerRole: PartnerRole;
  expiresAt: string;
  url: string;
  sentAt: string | null;
  delivered: boolean;
  skippedReason: string | null;
}

const formatDateTime = (value: string | null) =>
  value === null ? '—' : `${value.slice(0, 10).replaceAll('-', '/')} ${value.slice(11, 16)}`;

export function InvitationSection({ caseId, readOnly }: { caseId: string; readOnly: boolean }) {
  const [invitations, setInvitations] = useState<InvitationSummary[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<ContactChannel>('email');
  /** 平文URLは1度だけ表示する（6-3-6）。閉じると再表示できない。 */
  const [revealed, setRevealed] = useState<
    { role: PartnerRole; url: string; expiresAt: string; note: string | null } | null
  >(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ invitations: InvitationSummary[] }>(
        `/api/cases/${caseId}/invitations`,
      );
      setInvitations(result.invitations);
    } catch (error) {
      setInvitations([]);
      setSummary(
        error instanceof ApiCallError ? error.message : '招待状況を取得できませんでした。',
      );
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reissueAndReveal(role: PartnerRole) {
    if (busy) return;
    setBusy(true);
    setSummary(null);
    setCopyNote(null);
    try {
      const issued = await api.post<IssueResponse>(`/api/cases/${caseId}/invitations`, {
        targetPartnerRole: role,
      });
      setRevealed({ role, url: issued.url, expiresAt: issued.expiresAt, note: null });
      await load();
    } catch (error) {
      setSummary(
        error instanceof ApiCallError ? error.message : '招待URLを発行できませんでした。',
      );
    } finally {
      setBusy(false);
    }
  }

  async function reissueAndSend(invitation: InvitationSummary) {
    if (busy) return;
    setBusy(true);
    setSummary(null);
    setCopyNote(null);
    try {
      const sent = await api.post<IssueResponse>(
        `/api/cases/${caseId}/invitations/${invitation.id}/send`,
        { channel },
      );
      // 送信が未構成でスキップされた場合、URLを見せないと誰も招待に到達できなくなる（13-1）
      setRevealed(
        sent.delivered
          ? null
          : {
              role: invitation.targetPartnerRole,
              url: sent.url,
              expiresAt: sent.expiresAt,
              note: sent.skippedReason ?? '送信は行われませんでした。',
            },
      );
      if (sent.delivered) {
        setCopyNote(`${CONTACT_CHANNEL_LABEL[channel]}で送信しました。`);
      }
      await load();
    } catch (error) {
      setSummary(error instanceof ApiCallError ? error.message : '送信できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopyNote('コピーしました。');
    } catch {
      setCopyNote('コピーできませんでした。URLを選択して手動でコピーしてください。');
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="section-head">招待状況</h2>

      <ErrorSummary message={summary} />
      {copyNote && (
        <div role="status" className="banner-info">
          <span>{copyNote}</span>
        </div>
      )}

      <div className="banner-info">
        <span>
          招待URLは保存されないため、送信も再表示も新しいURLの発行を伴います。
          発行すると、それまでのURLは使えなくなります。
        </span>
      </div>

      {invitations === null && <p className="text-label text-text-muted">読み込んでいます…</p>}

      {invitations !== null && invitations.length === 0 && (
        <p className="text-label text-text-muted">招待はまだ発行されていません。</p>
      )}

      {invitations !== null && invitations.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">対象</th>
                <th scope="col">発行日時</th>
                <th scope="col">送付チャネル</th>
                <th scope="col">状態</th>
                <th scope="col">有効期限</th>
                <th scope="col">最終送信日時</th>
                {!readOnly && <th scope="col">操作</th>}
              </tr>
            </thead>
            <tbody>
              {invitations.map((invitation) => (
                <tr key={invitation.id}>
                  <td>{PARTNER_ROLE_LABEL[invitation.targetPartnerRole]}</td>
                  <td>{formatDateTime(invitation.createdAt)}</td>
                  <td>{CONTACT_CHANNEL_LABEL[invitation.channel]}</td>
                  <td>
                    <InvitationStateBadge state={invitation.state} />
                  </td>
                  <td>{formatDateTime(invitation.expiresAt)}</td>
                  <td>{formatDateTime(invitation.lastSentAt)}</td>
                  {!readOnly && (
                    <td>
                      {invitation.state === 'used' ? (
                        // initial_registration は max_uses=1（6-3-6）。
                        // 登録済みの相手に新しいトークンを配ると二重登録の入口になるため操作を出さない。
                        <span className="text-caption text-text-muted">登録済み</span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy}
                            onClick={() => reissueAndSend(invitation)}
                          >
                            再発行して送信
                          </button>
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy}
                            onClick={() => reissueAndReveal(invitation.targetPartnerRole)}
                          >
                            再発行してURLを表示
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!readOnly && invitations !== null && invitations.length > 0 && (
        <div className="flex items-center gap-2">
          <label htmlFor="invitation-channel" className="text-caption text-text-muted">
            送信方法
          </label>
          <select
            id="invitation-channel"
            className="field w-auto"
            value={channel}
            onChange={(e) => setChannel(e.target.value as ContactChannel)}
          >
            {CONTACT_CHANNELS.map((value) => (
              <option key={value} value={value}>
                {CONTACT_CHANNEL_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
      )}

      {revealed && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="invitation-url-title"
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-text-primary/40 p-4"
        >
          <div className="card mt-16 w-full max-w-xl space-y-3">
            <h3 id="invitation-url-title" className="section-head">
              {PARTNER_ROLE_LABEL[revealed.role]}の招待URL
            </h3>
            {revealed.note && (
              <div role="alert" className="banner-error">
                <span>{revealed.note}</span>
              </div>
            )}
            <p className="text-label text-text-secondary">
              このURLを表示できるのは今回だけです。閉じる前にコピーしてご案内ください。
              （有効期限 {formatDateTime(revealed.expiresAt)}）
            </p>
            <input
              readOnly
              value={revealed.url}
              aria-label="招待URL"
              className="field font-mono text-caption"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary w-auto px-5 py-2"
                onClick={() => copy(revealed.url)}
              >
                コピー
              </button>
              <button
                type="button"
                className="btn-primary w-auto px-5 py-2"
                onClick={() => setRevealed(null)}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
