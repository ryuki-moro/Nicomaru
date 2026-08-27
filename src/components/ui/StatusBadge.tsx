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

const TASK_TONE: Record<TaskStatus, string> = {
  not_started: 'badge-neutral',
  submitted: 'badge-success',
  needs_fix: 'badge-danger',
  confirmed: 'badge-success',
  waived: 'badge-neutral',
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <span className={TASK_TONE[status]}>{TASK_STATUS_LABEL[status]}</span>;
}

const REVIEW_TONE: Record<ReviewStatus, string> = {
  draft: 'badge-neutral',
  submitted: 'badge-warning',
  needs_fix: 'badge-danger',
  confirmed: 'badge-success',
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
