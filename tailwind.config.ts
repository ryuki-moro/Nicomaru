import type { Config } from 'tailwindcss';

/**
 * デザイントークンの正本は design-system/bridalhub-design-system.skill の
 * references/design_guide.md（6画面のモックアップから抽出した実測値）。
 * 画面ごとに独自の配色・サイズを発明しないよう、ここで名前付きトークンとして固定する。
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#F1EFE8',
        surface: '#FFFFFF',
        'text-primary': '#2C2C2A',
        'text-secondary': '#5F5E5A',
        // 小さなラベルもsurface/bg上で4.5:1以上にする（QA-08）。
        'text-muted': '#6F6B62',
        'border-light': '#ECEAE3',
        'border-mid': '#89857B',
        primary: '#B53B65',
        'primary-dark': '#993556',
        'primary-darker': '#72243E',
        'hero-bg': '#FBEAF0',
        link: '#185FA5',
        'info-bg': '#E6F1FB',
        'success-text': '#085041',
        'success-bg': '#E1F5EE',
        'warning-text': '#854F0B',
        'warning-bg': '#FDF3E3',
        danger: '#B53035',
        'danger-bg': '#FCECEC',
        'field-filled-bg': '#F9F8F5',
        line: '#06C755',
      },
      fontFamily: {
        sans: [
          '"Hiragino Kaku Gothic ProN"',
          '"Yu Gothic"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
      // 既定の文字サイズ（16px）のときにモックアップの実測値（コメントの px）と一致する。
      // rem と単位なしの行の高さにして、ブラウザ・端末の文字サイズ設定に追従させる。
      fontSize: {
        nav: ['0.625rem', '1.4'], // 10px / 14px
        caption: ['0.6875rem', '1.4545'], // 11px / 16px
        label: ['0.75rem', '1.5'], // 12px / 18px
        body: ['0.8125rem', '1.5385'], // 13px / 20px
        base: ['0.875rem', '1.5715'], // 14px / 22px
        section: ['0.9375rem', '1.4667'], // 15px / 22px
        title: ['1rem', '1.5'], // 16px / 24px
        logo: ['1.25rem', '1.4'], // 20px / 28px
        hero: ['2.5rem', '1.1'], // 40px / 44px
      },
      borderRadius: {
        badge: '20px',
        field: '8px',
        button: '10px',
        banner: '12px',
        card: '14px',
        hero: '18px',
        phone: '40px',
      },
      spacing: {
        screen: '28px',
      },
      maxWidth: {
        phone: '360px',
      },
    },
  },
  plugins: [],
};

export default config;
