/**
 * API 入力の検証スキーマ（zod）。
 *
 * 正本: 基本設計書 Version 1.2 4-3「画面レイアウト・入力チェック定義」および 6-5「API設計」。
 * 12-2 の開発標準により、値域は @/lib/constants を単一ソースとして参照する。
 * 型・必須チェックは API 層、業務ルールはサービス層で行う（6-5-1）。
 */
import { z } from 'zod';

import {
  ALLOWED_FILE_TYPES,
  CONTACT_CHANNELS,
  FOLLOW_METHODS,
  IMPORTANCE_LEVELS,
  INPUT_LIMITS,
  PARTNER_ROLES,
  PASSWORD_MIN_LENGTH,
  REVIEW_DECISIONS,
  SUBMISSION_FORMATS,
} from '@/lib/constants';
import { type ErrorDetail } from '@/lib/errors';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付の形式が正しくありません');
const shortText = z.string().trim().min(1, '入力してください').max(INPUT_LIMITS.shortText);
const optionalTextArea = z.string().trim().max(INPUT_LIMITS.textArea).optional().nullable();
const email = z.string().trim().toLowerCase().email('メールアドレスの形式が正しくありません')
  .max(255);
const phone = z.string().trim().regex(/^[0-9-]*$/, '数字とハイフンのみで入力してください').max(30);

/** 今日以降の日付か（K03「過去日付不可」）。比較は UTC 日付文字列で行う。 */
const notPastDate = (value: string) => value >= new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ 認証（P01〜P03）
export const otpRequestSchema = z.object({
  email,
});

export const otpVerifySchema = z.object({
  email,
  code: z.string().trim().regex(/^\d{6}$/, '6桁の数字を入力してください'),
});

export const passwordLoginSchema = z.object({
  email,
  password: z.string().min(1, 'パスワードを入力してください'),
});

export const passwordResetRequestSchema = z.object({ email });

export const passwordUpdateSchema = z
  .object({
    password: z.string().min(PASSWORD_MIN_LENGTH, `${PASSWORD_MIN_LENGTH}文字以上で入力してください`),
    passwordConfirm: z.string(),
  })
  .refine((v) => v.password === v.passwordConfirm, {
    message: 'パスワードが一致しません',
    path: ['passwordConfirm'],
  });

/** P02 初回登録（表4-12）。挙式日等は招待トークンで案件に紐付くため入力しない。 */
export const initialRegisterSchema = z.object({
  token: z.string().min(1),
  email,
  fullName: shortText,
  termsAccepted: z.literal(true, { message: '利用規約への同意が必要です' }),
});

// ------------------------------------------------------------------ 案件（K03／K04）
export const caseCreateSchema = z.object({
  weddingDate: isoDate.refine(notPastDate, '過去の日付は指定できません'),
  weddingTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  groomName: shortText,
  brideName: shortText,
  contactEmail: email,
  /** K03「主連絡先」。選択した側に is_primary_contact=true と recipient_email を設定する（6-6-1） */
  primaryContact: z.enum(PARTNER_ROLES),
  contactChannel: z.enum(CONTACT_CHANNELS),
  guestCount: z.number().int().min(0).optional().nullable(),
  planTypeId: z.string().uuid('プラン種別を選択してください'),
  venueRoom: z.string().trim().max(INPUT_LIMITS.shortText).optional().nullable(),
  notes: optionalTextArea,
});

export const caseUpdateSchema = caseCreateSchema.partial().extend({
  primaryPlannerId: z.string().uuid().optional(),
  /** K04 の差分確認ダイアログで提示した内容に同意したか。false のときはプレビューのみ返す */
  confirmed: z.boolean().optional(),
});

// ------------------------------------------------------------- 宿題（K02／T02）
const optionsSchema = z.object({
  choices: z.array(z.string().trim().min(1).max(INPUT_LIMITS.shortText)).optional(),
}).passthrough();

export const caseTaskCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(INPUT_LIMITS.templateDescription).optional().nullable(),
    submissionFormat: z.enum(SUBMISSION_FORMATS),
    allowedFileTypes: z.array(z.enum(ALLOWED_FILE_TYPES)).default([]),
    options: optionsSchema.default({}),
    importance: z.enum(IMPORTANCE_LEVELS).default('normal'),
    isRequired: z.boolean().default(true),
    dueDate: isoDate,
  })
  .superRefine((v, ctx) => {
    if (v.submissionFormat === 'file' && v.allowedFileTypes.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['allowedFileTypes'],
        message: '受入ファイル形式を1つ以上選択してください' });
    }
    if (v.submissionFormat === 'select' && (v.options.choices ?? []).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['options'],
        message: '選択肢を1つ以上入力してください' });
    }
  });

export const caseTaskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(INPUT_LIMITS.templateDescription).optional().nullable(),
  dueDate: isoDate.optional(),
  /** 「対応不要にする」（機能5-5）。true で waived を付与する */
  waived: z.boolean().optional(),
});

/** T02 宿題テンプレート（表4-17）。逆算日数を持つ点が case_tasks と異なる。 */
export const taskTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(INPUT_LIMITS.templateDescription).optional().nullable(),
    submissionFormat: z.enum(SUBMISSION_FORMATS),
    allowedFileTypes: z.array(z.enum(ALLOWED_FILE_TYPES)).default([]),
    defaultOptions: optionsSchema.default({}),
    dueOffsetDays: z.number().int().min(0, '0以上の整数で入力してください'),
    importance: z.enum(IMPORTANCE_LEVELS),
    isRequired: z.boolean().default(true),
    active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.submissionFormat === 'file' && v.allowedFileTypes.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['allowedFileTypes'],
        message: '受入ファイル形式を1つ以上選択してください' });
    }
    if (v.submissionFormat === 'select' && (v.defaultOptions.choices ?? []).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['defaultOptions'],
        message: '選択肢を1つ以上入力してください' });
    }
  });

/** T03 プラン種別（表4-18）。 */
export const planTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(INPUT_LIMITS.shortText),
    description: z.string().trim().max(INPUT_LIMITS.templateDescription).optional().nullable(),
    defaultGuestCountMin: z.number().int().min(0).optional().nullable(),
    defaultGuestCountMax: z.number().int().min(0).optional().nullable(),
    taskTemplateIds: z.array(z.string().uuid()).min(1, '宿題テンプレートを1件以上選択してください'),
    displayOrder: z.number().int().min(0).default(0),
    active: z.boolean().default(true),
  })
  .refine(
    (v) => v.defaultGuestCountMax == null || v.defaultGuestCountMin == null
      || v.defaultGuestCountMax >= v.defaultGuestCountMin,
    { message: '上限は下限以上で入力してください', path: ['defaultGuestCountMax'] },
  );

// ------------------------------------------------------------------ 提出（M03）
export const submitTaskSchema = z.object({
  /** case_tasks.submission_format と一致させる。none は「確認しました」の1行（6-7） */
  submissionType: z.enum(SUBMISSION_FORMATS),
  textValue: z.string().trim().max(INPUT_LIMITS.answerText).optional().nullable(),
  selectedValue: z.string().trim().max(INPUT_LIMITS.shortText).optional().nullable(),
  fileId: z.string().uuid().optional().nullable(),
  comment: optionalTextArea,
  /** true なら一時保存（review_status='draft'）、false なら提出（'submitted'） */
  draft: z.boolean().default(false),
});

/** D02 提出物確認（表4-15）。不備あり時はコメント必須。 */
export const reviewSubmissionSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    comment: z.string().trim().max(INPUT_LIMITS.textArea).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'needs_fix' && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'],
        message: '不備の内容を入力してください' });
    }
  });

// ------------------------------------------------------ 招待・フォロー・利用者
export const invitationIssueSchema = z.object({
  targetPartnerRole: z.enum(PARTNER_ROLES),
  /** 発行と同時に送信する場合に指定する。省略時は発行のみ（URLを応答で1度だけ返す） */
  send: z.enum(CONTACT_CHANNELS).optional(),
});

export const invitationSendSchema = z.object({
  channel: z.enum(CONTACT_CHANNELS),
});

export const followLogSchema = z.object({
  method: z.enum(FOLLOW_METHODS),
  followedAt: z.string().datetime({ offset: true }),
  note: optionalTextArea,
});

/** U02 利用者登録（表4-19）。role・venue_id は画面から受け取らずサーバー側で決める。 */
export const userCreateSchema = z.object({
  displayName: shortText,
  email,
  phone: phone.optional().nullable(),
  /** system_admin が S02 から admin を作るときのみ指定する */
  venueId: z.string().uuid().optional(),
});

export const userUpdateSchema = z.object({
  displayName: shortText.optional(),
  email: email.optional(),
  phone: phone.optional().nullable(),
  status: z.enum(['active', 'invited', 'suspended']).optional(),
});

export const userDeleteSchema = z.object({
  /** 担当案件がある planner を削除する場合は引き継ぎ先が必須（U04） */
  successorPlannerId: z.string().uuid().optional(),
});

// ------------------------------------------------------------------ 変換ヘルパ
/** zod のエラーを 6-5-1 の details[] へ写像する。 */
export function toErrorDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '_',
    reason: issue.message,
  }));
}
