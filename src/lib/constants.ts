/**
 * DB値とUI表示名の単一ソース。
 *
 * 正本: 基本設計書 Version 1.2 表6-9「DB値とUI表示名の対応」。
 * 12-2 の開発標準により、画面ごとに独自の表示名を発明せず必ず本モジュールを参照する。
 * 値域を増減するときは、対応する CHECK 制約（supabase/migrations）も同時に変更する。
 */

// ---------------------------------------------------------------- ロール
export const ROLES = ['couple', 'planner', 'admin', 'system_admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  couple: '新郎新婦',
  planner: 'プランナー',
  admin: '式場管理者',
  system_admin: 'システム管理者',
};

/** planner／admin／system_admin をまとめて指す。RLS の staff 条件と対応する。 */
export const STAFF_ROLES: readonly Role[] = ['planner', 'admin', 'system_admin'];
export const isStaff = (role: Role): boolean => STAFF_ROLES.includes(role);

// ------------------------------------------------------------ 利用者の状態
export const USER_STATUSES = ['active', 'invited', 'suspended', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_STATUS_LABEL: Record<UserStatus, string> = {
  active: '利用中',
  invited: '招待済（初回設定待ち）',
  suspended: '停止中',
  deleted: '削除済',
};

// -------------------------------------------------------------- 宿題の状態
export const TASK_STATUSES = ['not_started', 'submitted', 'needs_fix', 'confirmed', 'waived'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: '未着手',
  submitted: '提出済',
  needs_fix: '不備あり',
  confirmed: '確認済',
  // 表6-9: DB上は waived（提出免除）、マイページ上の表示は「対応不要」
  waived: '対応不要',
};

/** M02 の状態フィルタタブ。既定タブ「すべて」では waived を除外する（4-3 M02）。 */
export const TASK_FILTER_TABS = [
  { key: 'all', label: 'すべて', statuses: null },
  { key: 'not_started', label: '未着手', statuses: ['not_started'] },
  { key: 'submitted', label: '提出済', statuses: ['submitted'] },
  { key: 'needs_fix', label: '不備あり', statuses: ['needs_fix'] },
  { key: 'confirmed', label: '確認済', statuses: ['confirmed'] },
  { key: 'waived', label: '対応不要', statuses: ['waived'] },
] as const satisfies readonly { key: string; label: string; statuses: readonly TaskStatus[] | null }[];

/** 「すべて」タブで除外する状態。 */
export const TASK_STATUSES_EXCLUDED_FROM_ALL: readonly TaskStatus[] = ['waived'];

/** 6-8 のリスク算出で「未提出」とみなす状態（6-6-2 の期限再計算の母集合と同一）。 */
export const UNSUBMITTED_TASK_STATUSES: readonly TaskStatus[] = ['not_started', 'needs_fix'];
/** 「未完了」= confirmed／waived 以外。 */
export const INCOMPLETE_TASK_STATUSES: readonly TaskStatus[] =
  ['not_started', 'submitted', 'needs_fix'];

// ------------------------------------------------------------ 提出の確認状態
export const REVIEW_STATUSES = ['draft', 'submitted', 'needs_fix', 'confirmed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  draft: '作成中',
  submitted: '提出済',
  needs_fix: '不備あり',
  confirmed: '確認済',
};

/** 未レビュー = 上書き更新の対象（6-7）。 */
export const UNREVIEWED_STATUSES: readonly ReviewStatus[] = ['draft', 'submitted'];

/** D02 でプランナーが付与できる確認結果。 */
export const REVIEW_DECISIONS = ['confirmed', 'needs_fix'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

// ------------------------------------------------------------------ 提出形式
export const SUBMISSION_FORMATS = ['text', 'select', 'file', 'none'] as const;
export type SubmissionFormat = (typeof SUBMISSION_FORMATS)[number];

export const SUBMISSION_FORMAT_LABEL: Record<SubmissionFormat, string> = {
  text: 'テキスト',
  select: '選択肢',
  file: 'ファイル',
  // 宿題定義上の提出形式。案件ごとの免除である waived とは別概念（表6-9）
  none: '提出不要',
};

/** 受入ファイル拡張子。ファイルの種別は submission_format ではなくこちらで表現する（表5-10）。 */
export const ALLOWED_FILE_TYPES = ['csv', 'jpg', 'png'] as const;
export type AllowedFileType = (typeof ALLOWED_FILE_TYPES)[number];

export const FILE_TYPE_MIME: Record<AllowedFileType, readonly string[]> = {
  csv: ['text/csv', 'application/csv', 'text/plain'],
  jpg: ['image/jpeg'],
  png: ['image/png'],
};

// ------------------------------------------------------------------ 重要度
export const IMPORTANCE_LEVELS = ['normal', 'important', 'critical'] as const;
export type Importance = (typeof IMPORTANCE_LEVELS)[number];

export const IMPORTANCE_LABEL: Record<Importance, string> = {
  normal: '通常',
  important: '重要',
  critical: '最重要',
};

/** 「重要宿題」= important 以上（6-8／付録B）。 */
export const IMPORTANT_TASK_LEVELS: readonly Importance[] = ['important', 'critical'];

// ------------------------------------------------------------------ リスク
export const RISK_LEVELS = ['low', 'caution', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_LEVEL_LABEL: Record<RiskLevel, string> = {
  low: '低',
  caution: '注意',
  high: '高',
};

/** 表6-9: 内部は caution で統一し、UI 表示は reasons で切り替える。 */
export const RISK_LEVEL_RANK: Record<RiskLevel, number> = { low: 0, caution: 1, high: 2 };

// ---------------------------------------------------------------- 案件・招待
export const CASE_STATUSES = ['draft', 'active', 'completed', 'archived'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  draft: '下書き',
  active: '進行中',
  completed: '完了',
  archived: 'アーカイブ済み',
};

export const CONTACT_CHANNELS = ['line', 'email'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const CONTACT_CHANNEL_LABEL: Record<ContactChannel, string> = {
  line: '公式LINE',
  email: 'メール',
};

/** Phase 1 で使う区分。partner_a／partner_b は Phase 2 の拡張（6-6-1）。 */
export const PARTNER_ROLES = ['groom', 'bride'] as const;
export type PartnerRole = (typeof PARTNER_ROLES)[number];

export const PARTNER_ROLE_LABEL: Record<PartnerRole, string> = {
  groom: '新郎',
  bride: '新婦',
};

export const INVITATION_PURPOSES = ['initial_registration', 'mypage_access'] as const;
export type InvitationPurpose = (typeof INVITATION_PURPOSES)[number];

/** K02 の招待状況セクションに表示する状態（4-3 K02）。 */
export type InvitationState = 'unused' | 'used' | 'expired' | 'revoked';

export const INVITATION_STATE_LABEL: Record<InvitationState, string> = {
  unused: '未使用',
  used: '使用済み',
  expired: '期限切れ',
  revoked: '失効',
};

export const FOLLOW_METHODS = ['phone', 'line', 'email', 'meeting', 'other'] as const;
export type FollowMethod = (typeof FOLLOW_METHODS)[number];

export const FOLLOW_METHOD_LABEL: Record<FollowMethod, string> = {
  phone: '電話',
  line: 'LINE',
  email: 'メール',
  meeting: '打ち合わせ',
  other: 'その他',
};

// --------------------------------------------------------------- 設定・上限
/**
 * 招待トークンの有効期限（13-1 開発チーム決定）。
 * 差し戻し時はこの定数だけを変更すればよい。
 */
export const INVITATION_TTL_DAYS: Record<InvitationPurpose, number> = {
  initial_registration: 14,
  mypage_access: 30,
};

export const INVITATION_MAX_USES: Record<InvitationPurpose, number> = {
  initial_registration: 1,
  mypage_access: 5,
};

/** 入力上限の既定値（4-3 冒頭。個別画面で上書きしない）。 */
export const INPUT_LIMITS = {
  shortText: 100,
  textArea: 1000,
  answerText: 2000,
  templateDescription: 500,
  fileBytes: 5 * 1024 * 1024,
  caseTotalFileBytes: 100 * 1024 * 1024,
} as const;

/** パスワード要件（6-3-1／13-1）。P03 の入力チェックもこの値を使う。 */
export const PASSWORD_MIN_LENGTH = 12;

/** 初回パスワード設定リンクの有効期限（6-3-1）。 */
export const INVITE_LINK_TTL_HOURS = 72;

/** ワンタイムコード（6-3-1／5-3 auth_rate_limits の初期値）。 */
export const OTP = {
  length: 6,
  ttlSeconds: 10 * 60,
  resendIntervalSeconds: 60,
  requestsPerHour: 5,
  verifyFailuresBeforeInvalidation: 5,
} as const;

/** レート制限の初期値（5-3）。上限超過は 429 RATE_LIMITED。 */
export const RATE_LIMITS = {
  otp_request: { windowSeconds: 3600, max: OTP.requestsPerHour },
  otp_verify: { windowSeconds: 3600, max: 20 },
  initial_register: { windowSeconds: 3600, max: 10 },
  password_reset: { windowSeconds: 3600, max: 10 },
} as const;

/** 一覧画面の既定表示件数（4-3 一覧画面共通）。 */
export const LIST_PAGE_SIZE = 50;

/**
 * couple_profiles は memo を列レベル権限で剥奪しているため `select *` が 42501 になる。
 * 参照は必ずこの列リストを使う（付録A／12-2 の単一ソース化）。
 */
export const COUPLE_PROFILE_COLUMNS =
  'id, case_id, user_profile_id, partner_role, full_name, kana, email, email_hash, ' +
  'phone, address, is_primary_contact, created_at, updated_at';

/** 一覧の既定並び順（4-3 M01／M02、6-6-2）。同着は id でタイブレークする。 */
export const TASK_ORDER = 'due_date, display_order, id';
