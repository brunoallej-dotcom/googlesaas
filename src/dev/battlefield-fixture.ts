/**
 * ============================================================================
 * FIXTURES DE TESTE. NÃO SÃO RESULTADOS DE AUDITORIA.
 * Usadas apenas por testes automatizados e pela página /dev/battlefield-preview (somente em
 * desenvolvimento). A geometria (coordenadas dos 49 pontos) vem do próprio agente; as posições
 * e os nomes são inventados e identificados como teste.
 * ============================================================================
 */
import { battlefieldAgent } from '@/agents/battlefield-agent';
import type {
  BattlefieldGridPoint,
  BattlefieldMetrics,
  FrontierLead,
  GridPointCompetitorLeader,
} from '@/types/gmn';
import { classifyGridPoint, formatRankLabel } from '@/lib/battlefield-map-utils';

export const FIXTURE_BANNER = 'DADOS DE TESTE — não são resultados de auditoria';

export type FixtureVariant = 'full' | 'partial' | 'unreadable' | 'empty' | 'error';

export const FIXTURE_VARIANTS: readonly FixtureVariant[] = [
  'full',
  'partial',
  'unreadable',
  'empty',
  'error',
];

/** Centro aproximado de Anápolis/GO, só para posicionar a fixture em um lugar real. */
export const FIXTURE_CENTER = { latitude: -16.3281, longitude: -48.9534 } as const;

const LEADERS: readonly GridPointCompetitorLeader[] = ['A', 'B'].map((suffix) => ({
  placeId: `FIXTURE_LEADER_${suffix}`,
  businessName: `Concorrente de teste ${suffix}`,
  primaryCategory: 'Categoria de teste',
  rating: 4.5,
  totalReviews: 100,
  hasWebsite: true,
  isDirectoryFiltered: false,
}));

export function buildFixtureLead(): FrontierLead {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    campaignId: '00000000-0000-4000-8000-0000000000c1',
    placeId: 'FIXTURE_PLACE_ID',
    cid: null,
    featureId: null,
    businessName: 'EMPRESA DE TESTE (fixture)',
    primaryCategory: 'Categoria de teste',
    secondaryCategories: [],
    frontierRank: 18,
    frontierPage: 1,
    rating: 4.6,
    totalReviews: 87,
    phoneRaw: null,
    phoneE164: null,
    whatsappStatus: 'MISSING',
    whatsappUrl: null,
    websiteStatus: 'MISSING',
    websiteUrl: null,
    addressRaw: null,
    isAddressHidden: false,
    isServiceAreaBusiness: false,
    coordinates: { ...FIXTURE_CENTER },
    claimedByOwner: true,
    businessHoursConfigured: true,
    attributesCount: 0,
    servicesListedCount: 0,
    descriptionText: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Posição de teste por distância à grade (padrão determinístico e arbitrário). */
function fixtureRankFor(row: number, col: number, pointIndex: number): number | null {
  const manhattan = Math.abs(row - 3) + Math.abs(col - 3);
  if (manhattan === 0) return 2;
  if (manhattan === 1) return col >= 3 ? 3 : 5;
  if (manhattan === 2) return row <= 3 ? 6 : 11;
  if (manhattan === 3) return pointIndex % 2 === 0 ? 14 : 19;
  return null;
}

export function buildFixtureBattlefield(
  variant: Exclude<FixtureVariant, 'empty' | 'error'> = 'full',
  center: { readonly latitude: number; readonly longitude: number } = FIXTURE_CENTER
): BattlefieldMetrics {
  const nodes = battlefieldAgent.build49PointMatrix(center.latitude, center.longitude, 500);
  const unreadableIndexes = variant === 'unreadable' ? new Set([6, 42]) : new Set<number>();
  const selected = variant === 'partial' ? nodes.slice(0, 30) : nodes;

  const points: BattlefieldGridPoint[] = selected.map((node) => {
    const unreadable = unreadableIndexes.has(node.pointIndex);
    const rank = unreadable ? null : fixtureRankFor(node.rowIndex, node.colIndex, node.pointIndex);
    const readStatus = unreadable ? 'UNREADABLE' : 'VALID';
    const tier = classifyGridPoint(readStatus, rank);
    return {
      pointIndex: node.pointIndex,
      rowIndex: node.rowIndex,
      colIndex: node.colIndex,
      latitude: node.latitude,
      longitude: node.longitude,
      distanceFromCenterMeters: node.distanceFromCenterMeters,
      readStatus,
      attemptsMade: unreadable ? 3 : 1,
      targetRank: rank,
      visualTier: tier,
      displayLabel: formatRankLabel(tier, rank),
      pointLeader: unreadable ? null : (LEADERS[node.rowIndex <= 3 ? 0 : 1] ?? null),
    };
  });

  // Mesmas fórmulas do BattlefieldAgent.executeBattlefieldGrid (usadas só para conferência).
  const valid = points.filter((pt) => pt.readStatus === 'VALID');
  const count = (tier: string): number => valid.filter((pt) => pt.visualTier === tier).length;
  const green = count('GREEN_TOP3');
  const yellow = count('YELLOW_TOP7');
  const red = count('RED_8_TO_20');
  const invisible = count('INVISIBLE');
  const denominator = Math.max(1, valid.length);
  const sum = valid.reduce((acc, pt) => acc + (pt.targetRank !== null ? pt.targetRank : 21), 0);
  const averagePosition = Number((sum / denominator).toFixed(2));

  return {
    roundId: `fixture-round-${variant}`,
    placeId: 'FIXTURE_PLACE_ID',
    pureKeyword: 'palavra-chave de teste',
    centerOfInterest: { latitude: center.latitude, longitude: center.longitude },
    zoomLevel: '15z',
    stepMeters: 500,
    totalGridPoints: 49,
    validPointsCount: valid.length,
    unreadablePointsCount: points.length - valid.length,
    greenTop3Count: green,
    yellowTop4To7Count: yellow,
    redRank8To20Count: red,
    invisibleCount: invisible,
    averagePosition,
    top3Percentage: Number(((green / denominator) * 100).toFixed(1)),
    top7Percentage: Number((((green + yellow) / denominator) * 100).toFixed(1)),
    invisibilityPercentage: Number(((invisible / denominator) * 100).toFixed(1)),
    points,
    historicalEvolution: {
      hasPreviousRound: false,
      previousRoundId: null,
      previousExecutedAt: null,
      previousGreenTop3Count: null,
      currentGreenTop3Count: green,
      greenPointsDelta: null,
      previousAveragePosition: null,
      currentAveragePosition: averagePosition,
      averagePositionDelta: null,
      evolutionSummaryText: 'Fixture sem rodada anterior.',
    },
    executedAt: '2026-01-01T12:00:00.000Z',
  };
}
