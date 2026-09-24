import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: '#141413',
        coal: '#181715',
        graphite: '#2a2825',
      },
    },
  },
  plugins: [],
} satisfies Config;
