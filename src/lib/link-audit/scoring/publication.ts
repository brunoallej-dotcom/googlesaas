import { RULES } from './ruler';
import type { Publication, PublicationGate, PublicationStatus, Totals } from './types';

/**
 * Estados de publicação (decisão final do usuário):
 *   sem dados -> indisponível; cobertura < 40 % -> indisponível; 40–64 % -> provisório; >= 65 % -> publicável
 * (sempre com cobertura, confiança e limitações), exigindo ainda 3 critérios com >= 3 pontos possíveis avaliados
 * (entre eles NAP ou Avaliações) e integridade.
 */
export function buildPublication(totals: Totals, integrityOk: boolean): Publication {
  const evaluated = totals.evaluatedHalfPoints > 0;
  const coverageOk = totals.coveragePercent >= RULES.minCoveragePercent;
  const criteriaOk = totals.criteriaWithMinPoints.length >= RULES.minCriteria;
  const napOrReviews = totals.criteriaWithMinPoints.includes('NAP') || totals.criteriaWithMinPoints.includes('REVIEWS');
  const gates: PublicationGate[] = [
    { id: 'EVALUATED_DATA', passed: evaluated, text: evaluated ? 'Há pontos possíveis avaliados (denominador maior que zero).' : 'Nenhum ponto possível foi avaliado (denominador zero).' },
    { id: 'COVERAGE_MIN', passed: coverageOk, text: `Cobertura global de ${totals.coveragePercent}% (mínimo de ${RULES.minCoveragePercent}%).` },
    { id: 'CRITERIA_MIN', passed: criteriaOk, text: `${totals.criteriaWithMinPoints.length} critério(s) com pelo menos ${RULES.minCriterionEvaluatedPoints} pontos possíveis efetivamente avaliados (mínimo de ${RULES.minCriteria}).` },
    { id: 'NAP_OR_REVIEWS', passed: napOrReviews, text: 'Entre os critérios com pontos suficientes avaliados há NAP ou Avaliações.' },
    { id: 'INTEGRITY', passed: integrityOk, text: 'Invariantes dos pontos e rastreabilidade de cada ponto verificadas.' },
  ];
  let status: PublicationStatus;
  if (!evaluated) status = 'NO_DATA';
  else if (!coverageOk || !criteriaOk || !napOrReviews || !integrityOk) status = 'INSUFFICIENT';
  else status = totals.coveragePercent < RULES.publishedFromCoveragePercent ? 'PROVISIONAL' : 'PUBLISHED';
  const failed = gates.filter((gate) => !gate.passed).map((gate) => gate.text);
  const statusText = {
    NO_DATA: 'Índice indisponível: nenhum ponto pôde ser avaliado (sem dados). O índice nunca é zero por falta de dados.',
    INSUFFICIENT: `Índice indisponível: ${failed.join(' ')}`,
    PROVISIONAL: `Índice provisório (cobertura de ${totals.coveragePercent}%, entre ${RULES.minCoveragePercent}% e ${RULES.publishedFromCoveragePercent - 1}%): não é um relatório definitivo.`,
    PUBLISHED: `Índice publicável (cobertura de ${totals.coveragePercent}%), acompanhado de cobertura, confiança e limitações.`,
  }[status];
  return { status, gates, statusText };
}
