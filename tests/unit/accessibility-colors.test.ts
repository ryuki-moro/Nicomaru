import { describe, expect, it } from 'vitest';

import config from '../../tailwind.config';

const colors = config.theme!.extend!.colors as Record<string, string>;

function rgb(hex: string): number[] {
  return hex
    .slice(1)
    .match(/../g)!
    .map((value) => parseInt(value, 16) / 255);
}
function luminance(values: number[]): number {
  const linear = values.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function ratio(foreground: string, background: string, opacity = 1): number {
  const back = rgb(background);
  const front = rgb(foreground).map(
    (value, index) => value * opacity + back[index] * (1 - opacity),
  );
  const a = luminance(front);
  const b = luminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('主要UIの文字と入力境界のコントラスト（WCAG 2.2）', () => {
  it.each(['surface', 'bg', 'field-filled-bg'])(
    '%s上の本文・補助文字・リンク・エラーは4.5:1以上',
    (background) => {
      for (const foreground of [
        'text-primary',
        'text-secondary',
        'text-muted',
        'primary',
        'link',
        'danger',
      ]) {
        expect(ratio(colors[foreground], colors[background]), foreground).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    },
  );
  it('主ボタンの通常・hover時に白文字が4.5:1以上', () => {
    // hover:opacity-90 は白背景への合成も考慮する。
    const normal = ratio('#FFFFFF', colors.primary);
    const hoverBackground =
      '#' +
      rgb(colors.primary)
        .map((value) =>
          Math.round((value * 0.9 + 0.1) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
    expect(normal).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#FFFFFF', hoverBackground)).toBeGreaterThanOrEqual(4.5);
  });
  it.each([
    ['danger', 'danger-bg'],
    ['success-text', 'success-bg'],
    ['warning-text', 'warning-bg'],
    ['link', 'info-bg'],
  ])('%s / %s のバナー文字が4.5:1以上', (foreground, background) => {
    expect(ratio(colors[foreground], colors[background])).toBeGreaterThanOrEqual(4.5);
  });
  it('操作対象を識別する入力境界は内側・外側とも3:1以上', () => {
    for (const background of ['surface', 'bg']) {
      expect(ratio(colors['border-mid'], colors[background])).toBeGreaterThanOrEqual(3);
    }
  });
});
