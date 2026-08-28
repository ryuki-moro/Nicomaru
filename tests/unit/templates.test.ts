/**
 * 付録D「通知・メッセージ一覧」表81 の文面規約を検証する。
 *
 * 第11章「通知文面レビュー」はプランナー2名以上の目視確認を求めており、
 * ここでのテストはその前段のふるい。目視の前に、規約違反が構造的に混ざらないことを固める。
 */
import { describe, expect, it } from 'vitest';

import {
  BODY_LIMIT,
  NOTIFICATION_TYPES,
  checkNotificationText,
  renderNotification,
  type TemplateVars,
} from '@/lib/notify/templates';

const vars: TemplateVars = {
  coupleName: '山田 太郎',
  plannerName: '幸地',
  taskName: 'ゲストリスト提出',
  dueDate: '2026年8月28日',
  daysLeft: 7,
  reviewComment: 'ご住所の記載',
  subject: '会場のご案内',
  message: '当日の受付時間が決まりました。',
  url: 'https://example.test/mypage',
};

describe('renderNotification（付録D 表81）', () => {
  it.each(NOTIFICATION_TYPES)('%s: テンプレート変数が残らない', (type) => {
    const { title, body } = renderNotification(type, vars);
    expect(title).not.toMatch(/\{\{|\}\}/);
    expect(body).not.toMatch(/\{\{|\}\}/);
  });

  it.each(NOTIFICATION_TYPES)('%s: 宛名を必ず入れる', (type) => {
    const { body } = renderNotification(type, vars);
    expect(body).toContain('山田 太郎さま');
  });

  it.each(['due_reminder', 'overdue', 'info'] as const)(
    '%s: 担当プランナーの名前で締める',
    (type) => {
      const { body } = renderNotification(type, vars);
      expect(body).toContain('幸地');
    },
  );

  it.each(NOTIFICATION_TYPES)('%s: NG表現を含まない', (type) => {
    const { body } = renderNotification(type, vars);
    expect(checkNotificationText(body)).toEqual({ ok: true, violations: [] });
  });

  it.each(NOTIFICATION_TYPES)('%s: 想定文字数の上限に収まる', (type) => {
    const { body } = renderNotification(type, vars);
    expect(body.length).toBeLessThanOrEqual(BODY_LIMIT[type].default);
  });

  it('overdue でも「期限の調整も可能」と相談先を示す（催促にしない）', () => {
    const { body } = renderNotification('overdue', vars);
    expect(body).toContain('期限の調整も可能');
    expect(body).toContain('ご相談ください');
  });

  it('変数が欠けてもテンプレート記法が漏れない', () => {
    const minimal: TemplateVars = { coupleName: '新郎新婦', plannerName: '' };
    for (const type of NOTIFICATION_TYPES) {
      const { title, body } = renderNotification(type, minimal);
      expect(`${title}${body}`).not.toMatch(/\{\{|\}\}|undefined|null/);
    }
  });
});

describe('checkNotificationText（付録D の表現基準）', () => {
  it.each([
    ['まだ提出されていません', '未達を強調する表現'],
    ['至急ご対応ください', '断定的な催促'],
    ['必ずご提出ください', '断定的な催促'],
    ['ご提出が遅れています', '未達を強調する表現'],
    ['ご確認ください！', '感嘆符'],
    ['早くご提出ください', '断定的な催促'],
  ])('「%s」を NG として検出する', (text, reason) => {
    const result = checkNotificationText(text);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.reason)).toContain(reason);
  });

  it('相談先と選択肢を示す表現は通す', () => {
    const ok = 'ご準備がお済みでしたらマイページからご提出ください。'
      + 'ご都合がつかない場合は期限の調整も可能ですのでご相談ください。';
    expect(checkNotificationText(ok).ok).toBe(true);
  });
});
