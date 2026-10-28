import { CRITERIA } from '../methodology';
import { canonicalJson } from '../canonical';
import { aggregate, computeIndex, computeNaSensitivity } from './aggregate';
import { computeConfidence } from './confidence';
import { buildPublication } from './publication';
import { SUBCRITERIA } from './ruler';
import { NA_CODES, SAMPLE_CODES, type CriterionResult, type ScoreResult, type SubcriterionResult, type Totals } from './types';

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** Invariantes do manual (obtidos <= avaliados <= peso), partição de estados e rastreabilidade de cada ponto. */
export function checkCore(subs: readonly SubcriterionResult[], criteria: readonly CriterionResult[], totals: Totals): string[] {
  const issues: string[] = [];
  if (subs.length !== SUBCRITERIA.length) issues.push(`quantidade de subcritérios inválida (${subs.length})`);
  SUBCRITERIA.forEach((def, index) => {
    const sub = subs[index];
    if (!sub || sub.id !== def.id) {
      issues.push(`subcritério fora de ordem ou ausente na posição ${index}`);
      return;
    }
    if (sub.criterionId !== def.criterionId || sub.maxHalfPoints !== def.maxHalfPoints) issues.push(`${sub.id}: critério ou máximo divergem da régua`);
    const evaluated = sub.state === 'SCORED' || sub.state === 'ABSENCE_PROVEN';
    if (evaluated) {
      if (sub.evaluatedHalfPoints !== sub.maxHalfPoints) issues.push(`${sub.id}: pontos avaliados precisam ser o máximo do subcritério`);
      if (!Number.isInteger(sub.obtainedHalfPoints) || sub.obtainedHalfPoints < 0 || sub.obtainedHalfPoints > sub.evaluatedHalfPoints) issues.push(`${sub.id}: pontos obtidos fora de 0..avaliados`);
      if (sub.state === 'ABSENCE_PROVEN' && sub.obtainedHalfPoints !== 0) issues.push(`${sub.id}: ausência comprovada precisa valer 0`);
      if (sub.evidenceIds.length === 0) issues.push(`${sub.id}: ponto sem evidência verificada armazenada (rastreabilidade)`);
    } else if (sub.evaluatedHalfPoints !== 0 || sub.obtainedHalfPoints !== 0) {
      issues.push(`${sub.id}: estado ${sub.state} não pode ter pontos (Não verificado/Não aplicável/Amostra insuficiente ≠ zero)`);
    }
    const isNaCode = (NA_CODES as readonly string[]).includes(sub.reasonCode);
    const isSampleCode = (SAMPLE_CODES as readonly string[]).includes(sub.reasonCode);
    if ((sub.state === 'NOT_APPLICABLE') !== isNaCode) issues.push(`${sub.id}: código de motivo incompatível com o estado`);
    if ((sub.state === 'SAMPLE_INSUFFICIENT') !== isSampleCode) issues.push(`${sub.id}: código de amostra incompatível com o estado`);
  });
  for (const criterion of CRITERIA) {
    const sum = SUBCRITERIA.filter((def) => def.criterionId === criterion.id).reduce((total, def) => total + def.maxHalfPoints, 0);
    if (sum !== criterion.maxWeight * 2) issues.push(`${criterion.id}: soma dos subcritérios (${sum / 2}) ≠ peso (${criterion.maxWeight})`);
  }
  const expected = aggregate(subs);
  if (!same(criteria, expected.criteria)) issues.push('critérios divergem da soma dos subcritérios');
  if (!same(totals, expected.totals)) issues.push('totais divergem da soma dos critérios');
  for (const criterion of criteria) {
    if (!(criterion.obtainedHalfPoints <= criterion.evaluatedHalfPoints && criterion.evaluatedHalfPoints <= criterion.weight * 2)) {
      issues.push(`${criterion.id}: viola obtidos ≤ avaliados ≤ peso`);
    }
    const partition = criterion.evaluatedHalfPoints + criterion.notApplicableHalfPoints + criterion.sampleInsufficientHalfPoints + criterion.notVerifiedHalfPoints;
    if (partition !== criterion.weight * 2) issues.push(`${criterion.id}: partição dos estados não fecha o peso`);
  }
  if (CRITERIA.reduce((sum, criterion) => sum + criterion.maxWeight, 0) !== 100) issues.push('a soma dos pesos não é 100');
  return issues;
}

/** Revalida um resultado COMPLETO recalculando tudo o que dele deriva. */
export function checkResult(result: ScoreResult): string[] {
  const issues = checkCore(result.subcriteria, result.criteria, result.totals);
  const publication = buildPublication(result.totals, true);
  if (!same(result.publication, publication)) issues.push('estado de publicação diverge do recalculado');
  const available = publication.status === 'PROVISIONAL' || publication.status === 'PUBLISHED';
  const index = available ? computeIndex(result.totals) : null;
  if (!same(result.index, index)) issues.push('índice diverge do recalculado');
  const confidence = index ? computeConfidence(result.subcriteria, result.criteria, result.totals, result.conflicts) : null;
  if (!same(result.confidence, confidence)) issues.push('confiança diverge da recalculada');
  if (!same(result.naSensitivity, index ? computeNaSensitivity(result.totals) : null)) issues.push('sensibilidade do N/A diverge da recalculada');
  const naIds = new Set(result.subcriteria.filter((sub) => sub.state === 'NOT_APPLICABLE').map((sub) => sub.id));
  if (result.naRegistry.length !== naIds.size || result.naRegistry.some((entry) => !naIds.has(entry.subcriterionId))) issues.push('registro de N/A diverge dos subcritérios N/A');
  return issues;
}
