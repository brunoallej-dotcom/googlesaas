import type { EvidenceStatus } from '@/lib/evidence/types';

/**
 * Cálculo único dos indicadores do Juiz (usado pelo agente, pelo dashboard e pelo PDF).
 *
 * A fórmula histórica NÃO muda: média ponderada normalizada pela soma dos pesos,
 * `Σ(pontuação × peso) ÷ Σ pesos`. Os novos indicadores são calculados em paralelo e não
 * substituem o score histórico.
 */
export interface ScorableItem {
  readonly itemNumber: number;
  readonly maxWeight: number;
  /**
   * 0 a 100, pela metodologia original. `null` = critério sem nenhuma base de pontuação (dado
   * indisponível): não é zero nem 100, e fica fora do numerador E do denominador.
   */
  readonly scoreAwarded: number | null;
  readonly evidenceStatus: EvidenceStatus;
}

export interface StatusBucket {
  readonly count: number;
  readonly weight: number;
  readonly weightPercent: number;
}

export interface JudgeScoreSummary {
  /**
   * Pontuação RECALCULADA nesta emissão: média ponderada (a mesma fórmula do Juiz original) apenas
   * sobre os critérios que têm pontuação. NÃO é o "Score Juiz histórico" gravado por auditorias
   * anteriores: aquele usa os 21 critérios (denominador 102), inclusive dados simulados ou fixos.
   * Os critérios sem pontuação (`scoreAwarded` nulo) ficam fora do numerador e do denominador.
   * `null` quando nenhum critério foi pontuado.
   */
  readonly recalculatedScore: number | null;
  /** Soma dos pesos que entraram no cálculo (denominador da pontuação recalculada). */
  readonly denominatorWeight: number;
  /** Soma dos pesos dos 21 critérios (102). */
  readonly totalWeight: number;
  /** Percentual do peso total que entrou no cálculo recalculado. */
  readonly scoredWeightPercent: number;
  /** A pontuação recalculada inclui pontuações apenas indicativas de critérios parcialmente verificados. */
  readonly includesPartialIndicative: boolean;
  /** Quando `true`, todos os critérios são VERIFIED (a pontuação recalculada é plenamente comprovada). */
  readonly fullyVerified: boolean;
  /** Pontuação ponderada só dos critérios VERIFIED; `null` se nenhum foi verificado. */
  readonly verifiedPerformance: number | null;
  /** Pontuação dos critérios parcialmente verificados, SEPARADA e nunca somada à verificada. */
  readonly partialPerformance: number | null;
  readonly buckets: Readonly<Record<EvidenceStatus, StatusBucket>>;
  /** Percentual do peso total sustentado por evidência VERIFIED. */
  readonly verifiedCoveragePercent: number;
  /** Parcialmente verificado, separado: não conta como cobertura verificada. */
  readonly partialCoveragePercent: number;
}

export const RECALCULATED_SCORE_METHOD =
  'Média ponderada: soma de (pontuação × peso) dividida pela soma dos pesos dos critérios pontuados, a mesma fórmula do Juiz original, sem tratar critério sem pontuação como zero nem como 100.';

const STATUSES: readonly EvidenceStatus[] = ['VERIFIED', 'PARTIALLY_VERIFIED', 'NOT_VERIFIED', 'SIMULATED'];

const round1 = (value: number): number => Number(value.toFixed(1));

function weightedAverage(items: readonly ScorableItem[]): number | null {
  const scored = items.filter((item) => item.scoreAwarded !== null);
  const weight = scored.reduce((sum, item) => sum + item.maxWeight, 0);
  if (weight <= 0) return null;
  const earned = scored.reduce((sum, item) => sum + ((item.scoreAwarded as number) / 100) * item.maxWeight, 0);
  return round1((earned / weight) * 100);
}

export function computeJudgeScores(items: readonly ScorableItem[]): JudgeScoreSummary {
  const totalWeight = items.reduce((sum, item) => sum + item.maxWeight, 0);
  const safeTotal = Math.max(1, totalWeight);

  const buckets = Object.fromEntries(
    STATUSES.map((status) => {
      const subset = items.filter((item) => item.evidenceStatus === status);
      const weight = subset.reduce((sum, item) => sum + item.maxWeight, 0);
      return [status, { count: subset.length, weight, weightPercent: round1((weight / safeTotal) * 100) }];
    })
  ) as Record<EvidenceStatus, StatusBucket>;

  const scoredWeight = items.filter((item) => item.scoreAwarded !== null).reduce((sum, item) => sum + item.maxWeight, 0);
  const recalculatedScore = weightedAverage(items);

  return {
    recalculatedScore,
    denominatorWeight: scoredWeight,
    totalWeight,
    scoredWeightPercent: round1((scoredWeight / safeTotal) * 100),
    includesPartialIndicative: items.some((item) => item.evidenceStatus === 'PARTIALLY_VERIFIED' && item.scoreAwarded !== null),
    fullyVerified: buckets.VERIFIED.count === items.length && items.length > 0,
    verifiedPerformance: weightedAverage(items.filter((item) => item.evidenceStatus === 'VERIFIED')),
    partialPerformance: weightedAverage(items.filter((item) => item.evidenceStatus === 'PARTIALLY_VERIFIED')),
    buckets,
    verifiedCoveragePercent: buckets.VERIFIED.weightPercent,
    partialCoveragePercent: buckets.PARTIALLY_VERIFIED.weightPercent,
  };
}

/** Resumo textual da cobertura, usado no dashboard e no PDF. */
export function describeCoverage(summary: JudgeScoreSummary, totalCriteria: number): string {
  const verified = summary.buckets.VERIFIED;
  const partial = summary.buckets.PARTIALLY_VERIFIED;
  const base = `${verified.count} de ${totalCriteria} critérios verificados · ${Math.round(summary.verifiedCoveragePercent)}% do peso`;
  return partial.count > 0
    ? `${base} (+${partial.count} parcialmente verificados, ${Math.round(summary.partialCoveragePercent)}% do peso, contados à parte)`
    : base;
}
