/**
 * 通知の件名・本文テンプレート。
 *
 * 正本: 基本設計書 Version 1.2 付録D「通知・メッセージ一覧」（表81）。
 *
 * 【表現の基準（付録D）】
 *   NG: 「まだ提出されていません」「至急」「必ず」「遅れています」など、
 *       未達を強調する語・断定的な催促・感嘆符
 *   OK: 「ご準備がお済みでしたら」「ご都合がつかない場合はご相談ください」
 *       「期限の調整も可能です」など、選択肢と相談先を併せて示す表現
 *   宛名を必ず入れ、担当プランナーの名前で締める。
 *
 * 文面を1箇所に集めるのは、9-3 のAI下書き（Phase 3）をこのテンプレートを基準に
 * 評価するため（7-2）と、第11章「通知文面レビュー」で
 * プランナー2名以上の目視確認を通す対象を明確にするため。
 */

export const NOTIFICATION_TYPES = [
  'due_reminder',
  'overdue',
  'submission_request',
  'needs_fix',
  'info',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABEL: Record<NotificationType, string> = {
  due_reminder: '期限のご案内',
  overdue: 'ご確認のお願い',
  submission_request: 'ご提出のご案内',
  needs_fix: 'ご確認のお願い',
  info: 'お知らせ',
};

/** 付録D の「想定文字数」。LINE はさらに短い上限を持つ。 */
export const BODY_LIMIT: Record<NotificationType, { default: number; line: number }> = {
  due_reminder: { default: 120, line: 80 },
  overdue: { default: 120, line: 80 },
  submission_request: { default: 100, line: 100 },
  needs_fix: { default: 140, line: 140 },
  info: { default: 200, line: 200 },
};

export interface TemplateVars {
  /** 新郎新婦名（宛名。付録D は「宛名を必ず入れ」と定める） */
  coupleName: string;
  /** 担当プランナー名（付録D は「担当プランナーの名前で締める」と定める） */
  plannerName: string;
  taskName?: string;
  dueDate?: string;
  daysLeft?: number;
  /** needs_fix の「確認内容」。プランナーが D02 で入力したコメント */
  reviewComment?: string;
  /** info の任意件名・本文 */
  subject?: string;
  message?: string;
  url?: string;
}

export interface RenderedNotification {
  title: string;
  body: string;
}

/**
 * 付録D 表81 のテンプレートを埋める。
 *
 * 変数が欠けても文章として破綻しないよう、欠落は素直に落とす
 * （テンプレートの `{{ }}` がそのまま新郎新婦に届くのが最悪の結果）。
 */
export function renderNotification(
  type: NotificationType,
  vars: TemplateVars,
): RenderedNotification {
  const task = vars.taskName ?? 'ご提出物';
  const planner = vars.plannerName || '担当プランナー';
  const to = `${vars.coupleName}さま`;
  const url = vars.url ? ` ${vars.url}` : '';

  switch (type) {
    case 'due_reminder':
      return {
        title: `${task}のご準備について`,
        body:
          `${to} ${task}のご提出期限が${vars.daysLeft ?? 0}日後`
          + `（${vars.dueDate ?? ''}）です。`
          + 'ご準備がお済みでしたらマイページからご提出ください。'
          + `ご不明な点は担当${planner}までお気軽にどうぞ。${url}`,
      };

    case 'overdue':
      return {
        title: `${task}のご確認のお願い`,
        body:
          `${to} ${task}のご提出期限（${vars.dueDate ?? ''}）を過ぎております。`
          + 'ご都合がつかない場合は期限の調整も可能ですので、'
          + `担当${planner}までご相談ください。${url}`,
      };

    case 'submission_request':
      return {
        title: `${task}のご案内`,
        body:
          `${to} ${task}のご入力をお願いしております。`
          + `${vars.dueDate ?? ''}までにマイページからご提出ください。${url}`,
      };

    case 'needs_fix':
      return {
        title: `${task}について1点ご確認ください`,
        body:
          `${to} ご提出いただいた${task}について、`
          + `${vars.reviewComment ?? '内容'}をご確認いただけますでしょうか。`
          + `お手数ですがマイページからご修正をお願いいたします。${url}`,
      };

    case 'info':
      return {
        title: vars.subject ?? 'お知らせ',
        body:
          `${to} ${vars.message ?? ''} `
          + `ご不明な点は担当${planner}までお気軽にどうぞ。`,
      };
  }
}

/**
 * 付録D が NG とする表現を含まないかを機械的に見る。
 *
 * 第11章「通知文面レビュー」はプランナー2名以上の目視確認を求めており、
 * これはその置き換えではなく前段のふるい。目視前に明らかなNGを落とすためのもの。
 * 9-3 のAI下書き（Phase 3）も同じ関数を通す。
 */
const NG_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /まだ提出されていません/, reason: '未達を強調する表現' },
  { pattern: /至急/, reason: '断定的な催促' },
  { pattern: /必ず/, reason: '断定的な催促' },
  { pattern: /遅れて(い|おり)ます/, reason: '未達を強調する表現' },
  { pattern: /[!！]/, reason: '感嘆符' },
  { pattern: /早く/, reason: '断定的な催促' },
];

export interface TextCheckResult {
  ok: boolean;
  violations: { reason: string; matched: string }[];
}

export function checkNotificationText(body: string): TextCheckResult {
  const violations = NG_PATTERNS.flatMap((rule) => {
    const m = body.match(rule.pattern);
    return m ? [{ reason: rule.reason, matched: m[0] }] : [];
  });
  return { ok: violations.length === 0, violations };
}
