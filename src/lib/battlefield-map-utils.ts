import type { GridPointReadStatus, GridPointVisualTier } from '@/types/gmn';

export interface MapCoordinate {
  readonly latitude: number;
  readonly longitude: number;
}

export interface TierMeta {
  /** Cor de preenchimento do marcador e do ponto da legenda. */
  readonly color: string;
  /** Cor do rótulo sobre o marcador, escolhida para contraste com `color`. */
  readonly textColor: string;
  /** Rótulo da legenda. */
  readonly legendLabel: string;
  /** Classificação curta usada nos popups. */
  readonly classification: string;
}

/** Cores como hex (não classes Tailwind): este módulo fica fora do `content` do Tailwind. */
export const TIER_META: Record<GridPointVisualTier, TierMeta> = {
  GREEN_TOP3: {
    color: '#22C55E',
    textColor: '#04260F',
    legendLabel: 'Top 3 (posições 1–3)',
    classification: 'Top 3',
  },
  YELLOW_TOP7: {
    color: '#F5B800',
    textColor: '#1F1500',
    legendLabel: 'Posições 4–7',
    classification: 'Top 7',
  },
  RED_8_TO_20: {
    color: '#DC2626',
    textColor: '#FFFFFF',
    legendLabel: 'Posições 8–20',
    classification: 'Posições 8 a 20',
  },
  INVISIBLE: {
    color: '#2563EB',
    textColor: '#FFFFFF',
    legendLabel: 'Acima de 20',
    classification: 'Acima de 20',
  },
  GRAY_UNREADABLE: {
    color: '#64748B',
    textColor: '#FFFFFF',
    legendLabel: 'Sem leitura',
    classification: 'Sem leitura',
  },
};

/** Ordem de exibição da legenda. */
export const TIER_ORDER: readonly GridPointVisualTier[] = [
  'GREEN_TOP3',
  'YELLOW_TOP7',
  'RED_8_TO_20',
  'INVISIBLE',
  'GRAY_UNREADABLE',
];

/**
 * Único ponto de configuração do mapa-base. Para trocar de provedor basta alterar aqui.
 * Política de uso dos tiles do OSM: https://operations.osmfoundation.org/policies/tiles/
 * (uso interativo apenas: sem download em massa, sem pré-carregamento, atribuição visível).
 */
export const MAP_TILE_CONFIG = {
  provider: 'OpenStreetMap',
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  maxZoom: 19,
} as const;

/** Distância (m) abaixo da qual a empresa é considerada no mesmo ponto da grade. */
export const COMPANY_COINCIDENCE_METERS = 10;

export function isValidCoordinate(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * Classifica um ponto pela regra de visualização:
 * sem leitura → cinza; sem posição (ou acima de 20) → azul; 1–3 verde; 4–7 amarelo; 8–20 vermelho.
 */
export function classifyGridPoint(
  readStatus: GridPointReadStatus,
  targetRank: number | null
): GridPointVisualTier {
  if (readStatus === 'UNREADABLE') return 'GRAY_UNREADABLE';
  if (targetRank === null || targetRank > 20) return 'INVISIBLE';
  if (targetRank <= 3) return 'GREEN_TOP3';
  if (targetRank <= 7) return 'YELLOW_TOP7';
  return 'RED_8_TO_20';
}

/** Rótulo mostrado dentro do marcador: `#6`, `>20` ou `S/L`. */
export function formatRankLabel(tier: GridPointVisualTier, rank: number | null): string {
  if (tier === 'GRAY_UNREADABLE') return 'S/L';
  if (tier === 'INVISIBLE' || rank === null) return '>20';
  return `#${rank}`;
}

const EARTH_RADIUS_METERS = 6371008.8;

export function haversineMeters(a: MapCoordinate, b: MapCoordinate): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isCoincident(
  a: MapCoordinate,
  b: MapCoordinate,
  thresholdMeters: number = COMPANY_COINCIDENCE_METERS
): boolean {
  return haversineMeters(a, b) <= thresholdMeters;
}

export function formatCoordinate(value: number): string {
  return value.toFixed(6);
}
