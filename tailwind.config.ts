import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: '#F6F7F5',
        surface: '#FFFFFF',
        line: '#E3E6E2',
        ink: '#1B1F1D',
        'ink-soft': '#5C645F',
        accent: '#0E7A5F',
        'accent-hover': '#0A6650',
      },
      borderRadius: {
        DEFAULT: '6px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(0, 0, 0, 0.06)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
