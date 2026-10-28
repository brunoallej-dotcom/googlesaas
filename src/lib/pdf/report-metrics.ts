import type { RivalsMetrics } from '@/types/gmn';
import type { BattlefieldMapModel, MapMarker } from '@/lib/battlefield-map-adapter';
import { CRITERION_GROUPS, groupLabel, leaderValuesAreDefault } from './report-evidence';
import type { CriterionAssessment } from './report-evidence';
import { formatNumber, formatPercent } from './report-format';
import type { CriterionGroupKey } from './report-types';

const round1 = (value: number): number => Number(value.toFixed(1));

export interface ClassBucket {
  readonly count: number;
  readonly weight: number;
  readonly weightPercent: number;
}

export interface GroupSummary {
  readonly key: CriterionGroupKey;
  readonly label: string;
  readonly criteria: readonly CriterionAssessment[];
  readonly verifiedCount: number;
}

export interface ScoreBreakdown {
  readonly totalWeight: number;
  readonly totalCriteria: number;
  /**
   * Score histórico recomposto pela fórmula do agente: Σ(pontuação × peso) ÷ Σ pesos, sobre os
   * critérios que têm pontuação. Em auditorias anteriores à Fase 4 todos têm.
   */
  readonly officialScore: number;
  readonly agentOfficialScore: number;
  readonly officialMatchesAgent: boolean;
  /** `true` quando todos os critérios têm pontuação (auditorias anteriores à Fase 4). */
  readonly allCriteriaScored: boolean;
  /** Soma dos pesos que entraram em `officialScore` (denominador da pontuação recomposta). */
  readonly scoredWeight: number;
  /** A pontuação recomposta inclui pontuações indicativas de critérios parcialmente verificados. */
  readonly includesPartialIndicative: boolean;
  /** Percentual do peso total que entrou no cálculo do score histórico. */
  readonly scoredWeightPercent: number;
  readonly verified: ClassBucket & { readonly performance: number | null };
  /** Parcialmente verificados: separados, nunca somados aos verificados. */
  readonly partial: ClassBucket & { readonly performance: number | null };
  readonly notVerified: ClassBucket;
  readonly simulated: ClassBucket;
  /**
   * Faixa possível do score histórico se os critérios sem comprovação valessem 0% ou 100%.
   * Só se aplica quando todos os critérios têm pontuação; do contrário é `null`.
   */
  readonly range: { readonly min: number; readonly max: number } | null;
  readonly groups: readonly GroupSummary[];
}

function bucket(items: readonly CriterionAssessment[], totalWeight: number): ClassBucket {
  const weight = items.reduce((sum, item) => sum + item.weight, 0);
  return {
    count: items.length,
    weight,
    weightPercent: totalWeight > 0 ? round1((weight / totalWeight) * 100) : 0,
  };
}

const earned = (item: CriterionAssessment): number => ((item.agentScore ?? 0) / 100) * item.weight;
const isScored = (item: CriterionAssessment): boolean => item.agentScore !== null;

function performanceOf(items: readonly CriterionAssessment[]): number | null {
  const scored = items.filter(isScored);
  const weight = scored.reduce((sum, item) => sum + item.weight, 0);
  return weight > 0 ? round1((scored.reduce((sum, item) => sum + earned(item), 0) / weight) * 100) : null;
}

/**
 * Preserva a fórmula oficial do Juiz (média ponderada normalizada pelo peso total). O desempenho
 * "nos critérios verificados" usa a MESMA fórmula, restrita aos critérios comprovados.
 */
export function computeScoreBreakdown(
  criteria: readonly CriterionAssessment[],
  agentOfficialScore: number
): ScoreBreakdown {
  const totalWeight = criteria.reduce((sum, item) => sum + item.weight, 0);
  const safeTotal = Math.max(1, totalWeight);

  const verifiedItems = criteria.filter((item) => item.evidenceClass === 'VERIFIED');
  const partialItems = criteria.filter((item) => item.evidenceClass === 'PARTIAL');
  const notVerifiedItems = criteria.filter((item) => item.evidenceClass === 'NOT_VERIFIED');
  const simulatedItems = criteria.filter((item) => item.evidenceClass === 'SIMULATED');

  const scoredItems = criteria.filter(isScored);
  const scoredWeight = scoredItems.reduce((sum, item) => sum + item.weight, 0);
  const officialScore = scoredWeight > 0 ? round1((scoredItems.reduce((sum, item) => sum + earned(item), 0) / scoredWeight) * 100) : 0;
  const allCriteriaScored = scoredItems.length === criteria.length;

  const verifiedBucket = bucket(verifiedItems, totalWeight);
  const verifiedScoredEarned = verifiedItems.filter(isScored).reduce((sum, item) => sum + earned(item), 0);
  const performance = performanceOf(verifiedItems);

  const unprovenWeight = totalWeight - verifiedBucket.weight;
  const range = allCriteriaScored
    ? {
        min: round1((verifiedScoredEarned / safeTotal) * 100),
        max: round1(((verifiedScoredEarned + unprovenWeight) / safeTotal) * 100),
      }
    : null;

  const keys: CriterionGroupKey[] = [...CRITERION_GROUPS.map((group) => group.key), 'OTHER'];
  const groups: GroupSummary[] = [];
  for (const key of keys) {
    const groupCriteria = criteria.filter((item) => item.groupKey === key);
    if (groupCriteria.length === 0) continue;
    groups.push({
      key,
      label: groupLabel(key),
      criteria: groupCriteria,
      verifiedCount: groupCriteria.filter((item) => item.evidenceClass === 'VERIFIED').length,
    });
  }

  return {
    totalWeight,
    totalCriteria: criteria.length,
    officialScore,
    agentOfficialScore,
    officialMatchesAgent: Math.abs(officialScore - agentOfficialScore) <= 0.1,
    allCriteriaScored,
    scoredWeight,
    includesPartialIndicative: criteria.some((item) => item.evidenceClass === 'PARTIAL' && item.agentScore !== null),
    scoredWeightPercent: round1((scoredWeight / safeTotal) * 100),
    verified: { ...verifiedBucket, performance },
    partial: { ...bucket(partialItems, totalWeight), performance: performanceOf(partialItems) },
    notVerified: bucket(notVerifiedItems, totalWeight),
    simulated: bucket(simulatedItems, totalWeight),
    range,
    groups,
  };
}

/* -------------------------------------------------------------------------- */
/* Território: análise por setor da grade 7x7 (sem nomes de bairro)           */
/* -------------------------------------------------------------------------- */

export type SectorKey = 'NORTH' | 'SOUTH' | 'WEST' | 'EAST' | 'CENTER';

export interface SectorSummary {
  readonly key: SectorKey;
  readonly label: string;
  readonly points: number;
  /** Pontos com leitura válida. */
  readonly valid: number;
  /** Válidos com a empresa entre as 20 primeiras posições. */
  readonly ranked: number;
  readonly top3: number;
  readonly top7: number;
  readonly averageRankedPosition: number | null;
}

const SECTOR_DEFS: readonly {
  readonly key: SectorKey;
  readonly label: string;
  readonly includes: (row: number, col: number) => boolean;
}[] = [
  { key: 'NORTH', label: 'Faixa norte', includes: (row) => row <= 2 },
  { key: 'SOUTH', label: 'Faixa sul', includes: (row) => row >= 4 },
  { key: 'WEST', label: 'Faixa oeste', includes: (_row, col) => col <= 2 },
  { key: 'EAST', label: 'Faixa leste', includes: (_row, col) => col >= 4 },
  { key: 'CENTER', label: 'Centro da grade', includes: (row, col) => row >= 2 && row <= 4 && col >= 2 && col <= 4 },
];

/** A grade é gerada linha a linha (norte para sul, oeste para leste): índice = linha × 7 + coluna. */
function rowCol(pointIndex: number): { readonly row: number; readonly col: number } {
  return { row: Math.floor(pointIndex / 7), col: pointIndex % 7 };
}

function summarizeSector(
  def: (typeof SECTOR_DEFS)[number],
  markers: readonly MapMarker[]
): SectorSummary {
  const inSector = markers.filter((marker) => {
    const { row, col } = rowCol(marker.pointIndex);
    return def.includes(row, col);
  });
  const valid = inSector.filter((marker) => marker.readStatus === 'VALID');
  const ranked = valid.filter((marker) => marker.rank !== null);
  const rankSum = ranked.reduce((sum, marker) => sum + (marker.rank ?? 0), 0);
  return {
    key: def.key,
    label: def.label,
    points: inSector.length,
    valid: valid.length,
    ranked: ranked.length,
    top3: valid.filter((marker) => marker.tier === 'GREEN_TOP3').length,
    top7: valid.filter((marker) => marker.tier === 'GREEN_TOP3' || marker.tier === 'YELLOW_TOP7').length,
    averageRankedPosition: ranked.length > 0 ? round1(rankSum / ranked.length) : null,
  };
}

export interface TerritoryAnalysis {
  readonly sectors: readonly SectorSummary[];
  readonly findings: readonly string[];
  /** Posição no ponto que coincide com a empresa (centro da grade), se houver leitura. */
  readonly companyPointLabel: string | null;
}

export function analyzeTerritory(model: BattlefieldMapModel): TerritoryAnalysis {
  const sectors = SECTOR_DEFS.map((def) => summarizeSector(def, model.markers));
  const { coverage, counts, percentages } = model;
  const findings: string[] = [];

  if (!model.hasData || coverage.valid === 0) {
    return { sectors, findings: ['Não há leituras válidas do território nesta auditoria.'], companyPointLabel: null };
  }

  const ranked = coverage.valid - counts.above20;
  findings.push(
    `Em ${ranked} dos ${coverage.valid} pontos válidos a empresa aparece entre as 20 primeiras posições; em ${counts.above20} (${formatPercent(percentages.above20)}) não aparece.`
  );

  if (counts.top3 === 0) {
    findings.push('Nenhum ponto da grade coloca a empresa no Top 3.');
  } else {
    findings.push(`${counts.top3} ${counts.top3 === 1 ? 'ponto coloca' : 'pontos colocam'} a empresa no Top 3 (${formatPercent(percentages.top3)} das leituras válidas).`);
  }

  const directional = sectors.filter((sector) => sector.key !== 'CENTER' && sector.valid >= 3);
  const withPresence = directional.filter((sector) => sector.ranked > 0);
  if (withPresence.length > 0) {
    const best = [...withPresence].sort(
      (a, b) => b.ranked / b.valid - a.ranked / a.valid || b.ranked - a.ranked
    )[0];
    if (best) {
      findings.push(
        `${best.label} concentra a maior presença: ${best.ranked} de ${best.valid} pontos entre as 20 primeiras posições${best.averageRankedPosition === null ? '' : ` (posição média ${formatNumber(best.averageRankedPosition)})`}.`
      );
    }
    const weakest = [...directional].sort((a, b) => a.ranked / a.valid - b.ranked / b.valid)[0];
    if (weakest && best && weakest.key !== best.key && weakest.ranked === 0) {
      findings.push(`${weakest.label} não tem nenhum ponto entre as 20 primeiras posições.`);
    }
  }

  const center = model.companyCoincidesWithPointIndex === null
    ? null
    : model.markers.find((marker) => marker.pointIndex === model.companyCoincidesWithPointIndex) ?? null;
  const companyPointLabel =
    center === null ? null : center.tier === 'GRAY_UNREADABLE' ? 'sem leitura' : center.rank === null ? 'acima de 20' : `#${center.rank}`;
  if (companyPointLabel !== null) {
    findings.push(`No ponto da grade que coincide com a localização da empresa, a posição lida foi ${companyPointLabel}.`);
  }

  findings.push('As direções (norte, sul, leste, oeste) são relativas à grade e ao mapa; não foram atribuídos nomes de bairros por aproximação.');
  return { sectors, findings, companyPointLabel };
}

/* -------------------------------------------------------------------------- */
/* Concorrentes: só campos coletados                                          */
/* -------------------------------------------------------------------------- */

export interface RivalRow {
  readonly rank: number;
  readonly name: string;
  readonly pointsLed: number;
  readonly dominanceSharePercent: number;
  /** Nota e avaliações só valem quando não coincidem com valores padrão do sistema. */
  readonly rating: number | null;
  readonly totalReviews: number | null;
  readonly ratingVerified: boolean;
}

/**
 * Nota, avaliações, fotos e taxa de resposta estimadas pelo agente de Rivais não são usadas.
 * Mantêm-se nome, pontos liderados e domínio (calculados da própria grade) e, com a ressalva
 * do valor padrão, nota e avaliações do líder.
 */
export function buildRivalRows(rivals: RivalsMetrics | undefined): readonly RivalRow[] {
  const list = Array.isArray(rivals?.topDominators) ? rivals.topDominators : [];
  return list.map((rival, index) => {
    const isDefault = leaderValuesAreDefault(rival.rating, rival.totalReviews);
    return {
      rank: index + 1,
      name: rival.businessName,
      pointsLed: rival.pointsWonAsNumberOne,
      dominanceSharePercent: rival.dominanceSharePercent,
      rating: isDefault ? null : rival.rating,
      totalReviews: isDefault ? null : rival.totalReviews,
      ratingVerified: !isDefault,
    };
  });
}
