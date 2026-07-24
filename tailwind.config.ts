import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: '#F4F6F4',
        surface: '#FFFFFF',
        'surface-2': '#FBFCFA',
        line: '#E4E8E4',
        'line-soft': '#F0F2EF',
        ink: '#16201B',
        'ink-soft': '#5A635D',
        'ink-faint': '#8A928C',
        'ink-mute': '#9AA39C',
        accent: '#0E7A5F',
        'accent-hover': '#0A6650',
        'accent-bright': '#16A37B',
        tint: '#E7F2ED',
      },
      // Осовременено: было 6px
      borderRadius: {
        DEFAULT: '10px',
      },
      // Мягкие многослойные тени вместо резких бордеров
      boxShadow: {
        card: '0 1px 2px rgba(27,31,29,0.04), 0 8px 24px -12px rgba(27,31,29,0.08)',
        'card-hover': '0 2px 4px rgba(27,31,29,0.04), 0 14px 30px -12px rgba(14,122,95,0.22)',
        pop: '0 12px 32px -8px rgba(31,41,55,0.18)',
        glow: '0 6px 14px -6px rgba(14,122,95,0.55)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
