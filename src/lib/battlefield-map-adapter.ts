import { computeTerritoryRankMetrics } from '@/lib/battlefield-metrics';
import type {
  BattlefieldGridPoint,
  BattlefieldMetrics,
  FrontierLead,
  GridPointReadStatus,
  GridPointVisualTier,
} from '@/types/gmn';
import {
  classifyGridPoint,
  formatRankLabel,
  haversineMeters,
  isValidCoordinate,
  COMPANY_COINCIDENCE_METERS,
} from './battlefield-map-utils';

export const EXPECTED_GRID_POINTS = 49;

/** Nome genérico que o agente usa quando o provedor não informa o título do líder. */
const GENERIC_LEADER_NAME = 'Concorrente Local #1';

export interface MapMarker {
  readonly pointIndex: number;
  /** Número exibido ao usuário: 1..49. */
  readonly pointNumber: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly tier: GridPointVisualTier;
  readonly rank: number | null;
  readonly label: string;
  readonly readStatus: GridPointReadStatus;
  readonly attempts: number | null;
  readonly distanceMeters: number | null;
  /** Só o nome: nota e avaliações do líder podem ser valores padrão do agente. */
  readonly leaderName: string | null;
}

export interface MapCompany {
  readonly latitude: number;
  readonly longitude: number;
  readonly name: string | null;
  readonly source: 'lead' | 'center';
}

export interface MapCoverage {
  readonly expected: number;
  /** Pontos recebidos da auditoria. */
  readonly collected: number;
  readonly valid: number;
  readonly unreadable: number;
  /** Pontos esperados que não vieram. */
  readonly missing: number;
  /** Pontos recebidos que não puderam ser plotados por coordenada inválida. */
  readonly invalid: number;
}

export interface MapCounts {
  readonly top3: number;
  readonly top4to7: number;
  /** Top 3 + posições 4–7. */
  readonly top7: number;
  readonly rank8to20: number;
  readonly above20: number;
  readonly unreadable: number;
}

export interface MapPercentages {
  readonly top3: number | null;
  readonly top7: number | null;
  readonly above20: number | null;
}

export interface MapEvolution {
  readonly previousExecutedAt: string | null;
  readonly previousGreenTop3Count: number | null;
  readonly greenPointsDelta: number | null;
  readonly averagePositionDelta: number | null;
  readonly summaryText: string;
}

export interface BattlefieldMapModel {
  readonly hasData: boolean;
  readonly markers: readonly MapMarker[];
  readonly company: MapCompany | null;
  /** pointIndex do marcador que coincide com a empresa (≤10 m), se houver. */
  readonly companyCoincidesWithPointIndex: number | null;
  readonly coverage: MapCoverage;
  readonly counts: MapCounts;
  /** Percentuais sobre as leituras válidas; `null` quando não há leitura válida. */
  readonly percentages: MapPercentages;
  /**
   * ÍNDICE de posição: média em que pontos fora do Top 20 valem 21 (convenção histórica). Não é a
   * posição real nesses pontos. Calculado dos próprios pontos, igual para o dashboard e o PDF.
   */
  readonly averagePosition: number | null;
  /** Média apenas das posições efetivamente conhecidas (1 a 20); `null` se nenhuma. */
  readonly knownPositionAverage: number | null;
  /** Pontos com posição conhecida (denominador de `knownPositionAverage`). */
  readonly knownPositionPoints: number;
  readonly keyword: string | null;
  readonly executedAt: string | null;
  /** Só existe quando há uma rodada anterior real (`previousRoundId` preenchido). */
  readonly evolution: MapEvolution | null;
  /** Muda quando os dados mudam: usado para reenquadrar o mapa só nesse caso. */
  readonly fitKey: string;
}

const ZERO_COUNTS: MapCounts = {
  top3: 0,
  top4to7: 0,
  top7: 0,
  rank8to20: 0,
  above20: 0,
  unreadable: 0,
};

export const EMPTY_BATTLEFIELD_MODEL: BattlefieldMapModel = {
  hasData: false,
  markers: [],
  company: null,
  companyCoincidesWithPointIndex: null,
  coverage: { expected: EXPECTED_GRID_POINTS, collected: 0, valid: 0, unreadable: 0, missing: EXPECTED_GRID_POINTS, invalid: 0 },
  counts: ZERO_COUNTS,
  percentages: { top3: null, top7: null, above20: null },
  averagePosition: null,
  knownPositionAverage: null,
  knownPositionPoints: 0,
  keyword: null,
  executedAt: null,
  evolution: null,
  fitKey: 'empty',
};

interface NormalizedPoint {
  readonly pointIndex: number | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly readStatus: GridPointReadStatus;
  readonly rank: number | null;
  readonly tier: GridPointVisualTier;
  readonly attempts: number | null;
  readonly distanceMeters: number | null;
  readonly leaderName: string | null;
  readonly plottable: boolean;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function leaderNameOf(point: BattlefieldGridPoint): string | null {
  const name = point.pointLeader?.businessName;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed.length === 0 || trimmed === GENERIC_LEADER_NAME ? null : trimmed;
}

/**
 * Lê um ponto vindo do banco (JSON) sem confiar no formato. Uma posição fora de 1..N inteira
 * ou um status desconhecido não é interpretado: o ponto vira "sem leitura".
 */
function normalizePoint(point: BattlefieldGridPoint): NormalizedPoint {
  const rawRank = (point as { targetRank?: unknown }).targetRank;
  const rankIsAbsent = rawRank === null || rawRank === undefined;
  const rankIsValid = typeof rawRank === 'number' && Number.isInteger(rawRank) && rawRank >= 1;

  const declaredValid = (point.readStatus as string) === 'VALID';
  const readStatus: GridPointReadStatus =
    declaredValid && (rankIsAbsent || rankIsValid) ? 'VALID' : 'UNREADABLE';
  const rank = readStatus === 'VALID' && rankIsValid ? (rawRank as number) : null;
  const tier = classifyGridPoint(readStatus, rank);

  const pointIndex =
    typeof point.pointIndex === 'number' && Number.isInteger(point.pointIndex) ? point.pointIndex : null;

  return {
    pointIndex,
    latitude: point.latitude,
    longitude: point.longitude,
    readStatus,
    rank,
    tier,
    attempts: finiteOrNull(point.attemptsMade),
    distanceMeters: finiteOrNull(point.distanceFromCenterMeters),
    leaderName: leaderNameOf(point),
    plottable: pointIndex !== null && isValidCoordinate(point.latitude, point.longitude),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function resolveCompany(
  battlefield: BattlefieldMetrics,
  lead: FrontierLead | null | undefined
): MapCompany | null {
  const leadCoords = lead?.coordinates;
  if (leadCoords && isValidCoordinate(leadCoords.latitude, leadCoords.longitude)) {
    return {
      latitude: leadCoords.latitude,
      longitude: leadCoords.longitude,
      name: lead?.businessName ?? null,
      source: 'lead',
    };
  }
  const center = battlefield.centerOfInterest;
  if (center && isValidCoordinate(center.latitude, center.longitude)) {
    return {
      latitude: center.latitude,
      longitude: center.longitude,
      name: lead?.businessName ?? null,
      source: 'center',
    };
  }
  return null;
}

/**
 * Transforma o resultado real do Campo de Batalha em dados para o mapa.
 * Função pura: não gera, estima nem preenche coordenadas nem posições. Os marcadores são
 * exatamente os pontos recebidos que têm coordenada válida.
 */
export function toBattlefieldMapModel(params: {
  readonly battlefield: BattlefieldMetrics | null | undefined;
  readonly lead?: FrontierLead | null;
  readonly auditId?: string | null;
}): BattlefieldMapModel {
  const { battlefield, lead, auditId } = params;
  if (!battlefield || !Array.isArray(battlefield.points)) {
    return EMPTY_BATTLEFIELD_MODEL;
  }

  const normalized = battlefield.points.map(normalizePoint);
  const markers: MapMarker[] = [];
  normalized.forEach((pt) => {
    if (!pt.plottable || pt.pointIndex === null) return;
    markers.push({
      pointIndex: pt.pointIndex,
      pointNumber: pt.pointIndex + 1,
      latitude: pt.latitude,
      longitude: pt.longitude,
      tier: pt.tier,
      rank: pt.rank,
      label: formatRankLabel(pt.tier, pt.rank),
      readStatus: pt.readStatus,
      attempts: pt.attempts,
      distanceMeters: pt.distanceMeters,
      leaderName: pt.leaderName,
    });
  });

  const valid = normalized.filter((pt) => pt.readStatus === 'VALID').length;
  const unreadable = normalized.length - valid;
  const countTier = (tier: GridPointVisualTier): number =>
    normalized.filter((pt) => pt.tier === tier).length;

  const top3 = countTier('GREEN_TOP3');
  const top4to7 = countTier('YELLOW_TOP7');
  const counts: MapCounts = {
    top3,
    top4to7,
    top7: top3 + top4to7,
    rank8to20: countTier('RED_8_TO_20'),
    above20: countTier('INVISIBLE'),
    unreadable,
  };

  const share = (count: number): number | null => (valid > 0 ? round1((count / valid) * 100) : null);
  const rankMetrics = computeTerritoryRankMetrics(
    normalized.map((pt) => ({ readStatus: pt.readStatus, targetRank: pt.rank }))
  );

  const company = resolveCompany(battlefield, lead);
  let coincides: number | null = null;
  if (company) {
    let nearest = Infinity;
    for (const marker of markers) {
      const distance = haversineMeters(company, marker);
      if (distance <= COMPANY_COINCIDENCE_METERS && distance < nearest) {
        nearest = distance;
        coincides = marker.pointIndex;
      }
    }
  }

  const evolutionSource = battlefield.historicalEvolution;
  const evolution: MapEvolution | null =
    evolutionSource && evolutionSource.hasPreviousRound && evolutionSource.previousRoundId
      ? {
          previousExecutedAt: evolutionSource.previousExecutedAt,
          previousGreenTop3Count: evolutionSource.previousGreenTop3Count,
          greenPointsDelta: evolutionSource.greenPointsDelta,
          averagePositionDelta: evolutionSource.averagePositionDelta,
          summaryText: evolutionSource.evolutionSummaryText,
        }
      : null;

  return {
    hasData: true,
    markers,
    company,
    companyCoincidesWithPointIndex: coincides,
    coverage: {
      expected: EXPECTED_GRID_POINTS,
      collected: normalized.length,
      valid,
      unreadable,
      missing: Math.max(0, EXPECTED_GRID_POINTS - normalized.length),
      invalid: normalized.filter((pt) => !pt.plottable).length,
    },
    counts,
    percentages: { top3: share(counts.top3), top7: share(counts.top7), above20: share(counts.above20) },
    averagePosition: rankMetrics.rankIndexAverage,
    knownPositionAverage: rankMetrics.knownPositionAverage,
    knownPositionPoints: rankMetrics.knownPositionPoints,
    keyword: battlefield.pureKeyword ?? null,
    executedAt: battlefield.executedAt ?? null,
    evolution,
    fitKey: `${auditId ?? ''}:${battlefield.roundId}`,
  };
}
