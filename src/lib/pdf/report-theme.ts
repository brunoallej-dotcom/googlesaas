import path from 'node:path';

/** Paleta do dossiê (briefing da Fase 3). Cores dos marcadores vêm de `TIER_META` (mesmas do dashboard). */
export const REPORT_COLORS = {
  navy: '#0A1427',
  navySoft: '#14223D',
  primary: '#247BFF',
  accent: '#36A3FF',
  text: '#18243A',
  muted: '#68788F',
  success: '#22C55E',
  warning: '#F5B800',
  danger: '#EF4444',
  bgSoft: '#F3F6FB',
  border: '#E1E8F2',
  borderStrong: '#C9D4E4',
  white: '#FFFFFF',
  // Classes de evidência (cores distintas e não dependentes só de verde/vermelho).
  verified: '#15803D',
  verifiedBg: '#E7F6EC',
  partial: '#B45309',
  partialBg: '#FEF1DC',
  notVerified: '#5B6B82',
  notVerifiedBg: '#EEF1F6',
  simulated: '#7C3AED',
  simulatedBg: '#F1EAFE',
} as const;

/** Geometria A4 em pontos. */
export const PAGE = {
  width: 595.28,
  height: 841.89,
  marginX: 40,
  marginTop: 40,
  /** Área reservada ao rodapé (nada de conteúdo abaixo de `height - footerReserve`). */
  footerReserve: 52,
} as const;

export const CONTENT_WIDTH = PAGE.width - PAGE.marginX * 2;
export const CONTENT_BOTTOM = PAGE.height - PAGE.footerReserve;

export const FONT_FILES = {
  regular: 'Inter-400.woff',
  medium: 'Inter-500.woff',
  semibold: 'Inter-600.woff',
  bold: 'Inter-700.woff',
} as const;

export type FontKey = keyof typeof FONT_FILES;

/** Nomes registrados no documento: Inter embutida ou, no modo padrão, Helvetica do PDF. */
export const FONT_NAMES: Record<FontKey, { readonly inter: string; readonly standard: string }> = {
  regular: { inter: 'Inter-400', standard: 'Helvetica' },
  medium: { inter: 'Inter-500', standard: 'Helvetica' },
  semibold: { inter: 'Inter-600', standard: 'Helvetica-Bold' },
  bold: { inter: 'Inter-700', standard: 'Helvetica-Bold' },
};

export function fontsDirectory(): string {
  return path.join(process.cwd(), 'assets', 'fonts');
}

export const REPORT_TYPE = {
  title: 26,
  h1: 17,
  h2: 12,
  h3: 10,
  body: 9,
  small: 7.8,
  tiny: 6.8,
} as const;

/** Nomes de fonte já registrados no documento, por peso. */
export interface FontSet {
  readonly regular: string;
  readonly medium: string;
  readonly semibold: string;
  readonly bold: string;
}

/** Remove ou substitui caracteres que a fonte do documento não tem (emojis, símbolos). */
export type TextSanitizer = (text: string) => string;
