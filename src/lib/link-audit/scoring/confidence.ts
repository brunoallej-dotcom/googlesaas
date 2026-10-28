import { formatHundredths, roundHalfUpDiv } from './math';
import { RULES } from './ruler';
import type { ConfidenceFactor, ConfidenceFactorId, ConfidenceLevel, ConfidenceResult, ConflictRecord, CriterionResult, SubcriterionResult, Totals } from './types';

const ORDER: Readonly<Record<ConfidenceLevel, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
export const CONFIDENCE_LABELS_PT: Readonly<Record<ConfidenceLevel, string>> = { HIGH: 'Alta', MEDIUM: 'Média', LOW: 'Baixa' };

const level = (high: boolean, medium: boolean): ConfidenceLevel => (high ? 'HIGH' : medium ? 'MEDIUM' : 'LOW');
const percent = (n: number, d: number): string => `${formatHundredths(roundHalfUpDiv(n * 10000, d))}%`;

/**
 * Confiança composta: o MENOR nível entre seis fatores determinísticos (aritmética inteira, limiares fechados).
 * Nenhum fator isolado concede "Alta" e as justificativas vêm de modelos fixos (nunca texto livre nem IA).
 */
export function computeConfidence(
  subs: readonly SubcriterionResult[],
  criteria: readonly CriterionResult[],
  totals: Totals,
  conflicts: readonly ConflictRecord[],
): ConfidenceResult {
  const c = RULES.confidence;
  const evaluated = subs.filter((sub) => sub.evaluatedHalfPoints > 0);
  const e = totals.evaluatedHalfPoints;
  const factors: ConfidenceFactor[] = [];

  const cov = totals.coveragePercent;
  factors.push({
    id: 'COVERAGE',
    level: level(cov >= c.coverageHighFrom, cov >= c.coverageMediumFrom),
    value: { n: cov, d: 1 },
    valueText: `${cov}%`,
    justification: `Cobertura global de ${cov}% (Alta a partir de ${c.coverageHighFrom}%; Média de ${c.coverageMediumFrom}% a ${c.coverageHighFrom - 1}%; Baixa abaixo de ${c.coverageMediumFrom}%).`,
    refs: evaluated.map((sub) => sub.id),
  });

  const counted = criteria.filter((criterion) => {
    const eligibleHalf = 2 * criterion.weight - criterion.notApplicableHalfPoints;
    return eligibleHalf > 0 && 2 * criterion.evaluatedHalfPoints >= eligibleHalf;
  });
  factors.push({
    id: 'BREADTH',
    level: level(counted.length >= c.breadthHighFrom, counted.length >= c.breadthMediumFrom),
    value: { n: counted.length, d: 1 },
    valueText: `${counted.length} critério(s)`,
    justification: `${counted.length} critério(s) com pelo menos metade do peso elegível avaliado (Alta com ${c.breadthHighFrom} ou mais; Média com ${c.breadthMediumFrom} a ${c.breadthHighFrom - 1}; Baixa com menos).`,
    refs: counted.map((criterion) => criterion.id),
  });

  const primaryHalf = evaluated.filter((sub) => sub.grade === 'PRIMARY').reduce((sum, sub) => sum + sub.evaluatedHalfPoints, 0);
  factors.push({
    id: 'RELIABILITY',
    level: level(100 * primaryHalf >= c.reliabilityHighFromPercent * e, 100 * primaryHalf >= c.reliabilityMediumFromPercent * e),
    value: { n: primaryHalf, d: e },
    valueText: percent(primaryHalf, e),
    justification: `${percent(primaryHalf, e)} dos pontos avaliados têm evidência primária (captura armazenada ou anexo com hash) (Alta a partir de ${c.reliabilityHighFromPercent}%; Média a partir de ${c.reliabilityMediumFromPercent}%; Baixa abaixo).`,
    refs: evaluated.filter((sub) => sub.grade !== 'PRIMARY').map((sub) => sub.id),
  });

  const agedSubs = evaluated.filter((sub) => (sub.maxEvidenceAgeDays ?? 0) > RULES.evidenceAgedAfterDays);
  const agedHalf = agedSubs.reduce((sum, sub) => sum + sub.evaluatedHalfPoints, 0);
  factors.push({
    id: 'FRESHNESS',
    level: level(100 * agedHalf <= c.freshnessHighUpToPercent * e, 100 * agedHalf <= c.freshnessMediumUpToPercent * e),
    value: { n: agedHalf, d: e },
    valueText: percent(agedHalf, e),
    justification: `${percent(agedHalf, e)} dos pontos avaliados dependem de evidência com mais de ${RULES.evidenceAgedAfterDays} dias em relação ao snapshot (Alta até ${c.freshnessHighUpToPercent}%; Média até ${c.freshnessMediumUpToPercent}%; Baixa acima). Evidência com mais de ${RULES.evidenceCannotGroundAfterDays} dias não fundamenta pontos.`,
    refs: agedSubs.map((sub) => sub.id),
  });

  const k = conflicts.length;
  factors.push({
    id: 'CONFLICTS',
    level: level(k === 0, k <= c.conflictsMediumUpTo),
    value: { n: k, d: 1 },
    valueText: `${k} conflito(s)`,
    justification: `${k} conflito(s) aberto(s) entre fontes (Alta sem conflitos; Média com até ${c.conflictsMediumUpTo}; Baixa com mais).`,
    refs: conflicts.map((conflict) => conflict.field),
  });

  const naHalf = totals.notApplicableHalfPoints;
  factors.push({
    id: 'NA_WEIGHT',
    level: level(naHalf <= 2 * c.naWeightHighUpTo, naHalf <= 2 * c.naWeightMediumUpTo),
    value: { n: naHalf, d: 2 },
    valueText: `${naHalf / 2} ponto(s)`,
    justification: `${naHalf / 2} ponto(s) de peso não aplicável (Alta até ${c.naWeightHighUpTo}; Média até ${c.naWeightMediumUpTo}; Baixa acima). Não aplicável não soma à cobertura nem altera o índice.`,
    refs: subs.filter((sub) => sub.state === 'NOT_APPLICABLE').map((sub) => sub.id),
  });

  const lowest = Math.min(...factors.map((factor) => ORDER[factor.level]));
  const final = (Object.keys(ORDER) as ConfidenceLevel[]).find((key) => ORDER[key] === lowest) ?? 'LOW';
  const limiting: ConfidenceFactorId[] = factors.filter((factor) => ORDER[factor.level] === lowest).map((factor) => factor.id);
  return { level: final, levelLabel: CONFIDENCE_LABELS_PT[final], factors, limitingFactors: limiting };
}
