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
      // nav／caption／label／body はモックアップの実測値より1段階大きくしている（Issue #203）。
      // 実測値のままだとプランナーの表や小さなラベルが読みにくいため、画面ごとに調整せず
      // トークン側で一括して上げる。見出し側（base 以上）は body との段差を保つために1pxずつ上げる。
      // 既定の文字サイズ（16px）のときにコメントの px と一致する。rem と単位なしの行の高さにして、
      // ブラウザ・端末の文字サイズ設定に追従させる。
      fontSize: {
        nav: ['0.6875rem', '1.3636'], // 11px / 15px
        caption: ['0.75rem', '1.5'], // 12px / 18px
        label: ['0.8125rem', '1.5385'], // 13px / 20px
        body: ['0.875rem', '1.5715'], // 14px / 22px
        base: ['0.9375rem', '1.6'], // 15px / 24px
        section: ['1rem', '1.5'], // 16px / 24px
        title: ['1.0625rem', '1.5295'], // 17px / 26px
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
        // 既定は 360px。新郎新婦側の入力系の画面だけ、PC幅で --screen-width を 560px に広げる
        // （(couple)/layout.tsx。ヘッダー・本文・下部ナビが同じ変数を見るので幅がそろう。Issue #207）
        phone: 'var(--screen-width, 360px)',
      },
    },
  },
  plugins: [],
};

export default config;
