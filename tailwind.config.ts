import type { Config } from 'tailwindcss';

/**
 * Cores como hex (não var()): o Tailwind 3 só gera modificadores de opacidade
 * (`bg-gmn-primary/20`, `border-gmn-border/60`) para cores que consegue decompor.
 */
const gmn = {
  bg: '#070D1C',
  sidebar: '#0A1427',
  card: '#111E33',
  tile: '#0D182B',
  surface: '#17263E',
  border: '#26364F',
  line: '#1C2A40',
  primary: '#247BFF',
  accent: '#36A3FF',
  text: '#F3F7FF',
  muted: '#91A3BF',
  success: '#22C55E',
  warning: '#F5B800',
  danger: '#EF4444',
} as const;

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: { gmn },
      // Borda padrão suave: nenhuma borda esquecida volta a ficar clara.
      borderColor: { DEFAULT: gmn.line },
      fontFamily: {
        sans: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
