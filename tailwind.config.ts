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
        'text-muted': '#B4B2A9',
        'border-light': '#ECEAE3',
        'border-mid': '#D3D1C7',
        primary: '#D4537E',
        'primary-dark': '#993556',
        'primary-darker': '#72243E',
        'hero-bg': '#FBEAF0',
        link: '#185FA5',
        'info-bg': '#E6F1FB',
        'success-text': '#085041',
        'success-bg': '#E1F5EE',
        'warning-text': '#854F0B',
        'warning-bg': '#FDF3E3',
        danger: '#E24B4A',
        'danger-bg': '#FCECEC',
        'field-filled-bg': '#F9F8F5',
        line: '#06C755',
      },
      fontFamily: {
        sans: ['"Hiragino Kaku Gothic ProN"', '"Yu Gothic"', '"Helvetica Neue"', 'Arial', 'sans-serif'],
      },
      fontSize: {
        nav: ['10px', '14px'],
        caption: ['11px', '16px'],
        label: ['12px', '18px'],
        body: ['13px', '20px'],
        base: ['14px', '22px'],
        section: ['15px', '22px'],
        title: ['16px', '24px'],
        logo: ['20px', '28px'],
        hero: ['40px', '44px'],
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
