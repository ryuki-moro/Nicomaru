/**
 * 状態バッジ。表示名は表6-9 を唯一の対応表とする（12-2 単一ソース化）。
 * 画面ごとに独自の表示名を作らない。
 */
import {
  REVIEW_STATUS_LABEL,
  TASK_STATUS_LABEL,
  INVITATION_STATE_LABEL,
  type InvitationState,
  type ReviewStatus,
  type TaskStatus,
} from '@/lib/constants';

/**
 * 宿題と提出物の確認状態で名前が共通する状態の色。両方の対応表がここから取るので、
 * 同じ「提出済」が画面によって違う色になることはない。緑は「確認済」だけに使い、
 * 提出済（確認待ち）は警告色で「まだ相手の番」と分かるようにする。
 */
const SHARED_TONE = {
  submitted: 'badge-warning',
  needs_fix: 'badge-danger',
  confirmed: 'badge-success',
} as const satisfies Partial<Record<TaskStatus & ReviewStatus, string>>;

const TASK_TONE: Record<TaskStatus, string> = {
  ...SHARED_TONE,
  not_started: 'badge-neutral',
  waived: 'badge-neutral',
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <span className={TASK_TONE[status]}>{TASK_STATUS_LABEL[status]}</span>;
}

const REVIEW_TONE: Record<ReviewStatus, string> = {
  ...SHARED_TONE,
  draft: 'badge-neutral',
};

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  return <span className={REVIEW_TONE[status]}>{REVIEW_STATUS_LABEL[status]}</span>;
}

const INVITATION_TONE: Record<InvitationState, string> = {
  unused: 'badge-warning',
  used: 'badge-success',
  expired: 'badge-neutral',
  revoked: 'badge-neutral',
};

export function InvitationStateBadge({ state }: { state: InvitationState }) {
  return <span className={INVITATION_TONE[state]}>{INVITATION_STATE_LABEL[state]}</span>;
}
