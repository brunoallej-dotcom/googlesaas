import { CRITERIA } from '../methodology';
import { reduceFrac, roundHalfUpDiv, formatHundredths, frac } from './math';
import { RULES } from './ruler';
import type { Classification, CriterionResult, CriterionStatus, IndexValue, SubcriterionResult, Totals } from './types';

export const CLASSIFICATION_LABELS_PT: Readonly<Record<Classification, string>> = {
  CRITICAL: 'Crítico',
  WEAK: 'Fraco',
  DEVELOPING: 'Em desenvolvimento',
  STRONG: 'Forte',
  LOCAL_REFERENCE: 'Referência local',
};

/** Classes sobre o INTEIRO exibido (74,5 -> 75 -> Forte). 40–59 = Fraco (proposta homologada). */
export function classify(shown: number): Classification {
  const c = RULES.classification;
  if (shown <= c.criticalUpTo) return 'CRITICAL';
  if (shown <= c.weakUpTo) return 'WEAK';
  if (shown <= c.developingUpTo) return 'DEVELOPING';
  if (shown <= c.strongUpTo) return 'STRONG';
  return 'LOCAL_REFERENCE';
}

export function aggregate(subs: readonly SubcriterionResult[]): { criteria: CriterionResult[]; totals: Totals } {
  const criteria: CriterionResult[] = CRITERIA.map((criterion) => {
    const own = subs.filter((sub) => sub.criterionId === criterion.id);
    const sum = (pick: (sub: SubcriterionResult) => number): number => own.reduce((total, sub) => total + pick(sub), 0);
    const evaluated = sum((sub) => sub.evaluatedHalfPoints);
    const na = sum((sub) => (sub.state === 'NOT_APPLICABLE' ? sub.maxHalfPoints : 0));
    const eligible = criterion.maxWeight * 2 - na;
    const status: CriterionStatus = eligible === 0 ? 'NOT_APPLICABLE' : evaluated === 0 ? 'NOT_VERIFIED' : evaluated === eligible ? 'EVALUATED' : 'PARTIAL';
    return {
      id: criterion.id,
      label: criterion.label,
      weight: criterion.maxWeight,
      status,
      obtainedHalfPoints: sum((sub) => sub.obtainedHalfPoints),
      evaluatedHalfPoints: evaluated,
      notApplicableHalfPoints: na,
      sampleInsufficientHalfPoints: sum((sub) => (sub.state === 'SAMPLE_INSUFFICIENT' ? sub.maxHalfPoints : 0)),
      notVerifiedHalfPoints: sum((sub) => (sub.state === 'NOT_VERIFIED' ? sub.maxHalfPoints : 0)),
      subcriteria: own.map((sub) => sub.id),
    };
  });
  const total = (pick: (criterion: CriterionResult) => number): number => criteria.reduce((sum, criterion) => sum + pick(criterion), 0);
  const evaluated = total((c) => c.evaluatedHalfPoints);
  const na = total((c) => c.notApplicableHalfPoints);
  const eligibleDen = 200 - na;
  const totals: Totals = {
    obtainedHalfPoints: total((c) => c.obtainedHalfPoints),
    evaluatedHalfPoints: evaluated,
    coveragePercent: evaluated / 2,
    notApplicableHalfPoints: na,
    sampleInsufficientHalfPoints: total((c) => c.sampleInsufficientHalfPoints),
    notVerifiedHalfPoints: total((c) => c.notVerifiedHalfPoints),
    eligibleCoverage: eligibleDen > 0 ? reduceFrac(frac(evaluated, eligibleDen)) : null,
    criteriaWithMinPoints: criteria.filter((c) => c.evaluatedHalfPoints >= RULES.minCriterionEvaluatedPoints * 2).map((c) => c.id),
    criteriaWithAnyPoints: criteria.filter((c) => c.evaluatedHalfPoints > 0).map((c) => c.id),
  };
  return { criteria, totals };
}

/** Índice caso o peso N/A contasse como zero: O ÷ (E + W_na) × 100 (transparência; o índice oficial não usa isso). */
export function computeNaSensitivity(totals: Totals): { shown: number; decimal2: string } | null {
  const o = totals.obtainedHalfPoints;
  const e = totals.evaluatedHalfPoints;
  const na = totals.notApplicableHalfPoints;
  if (e <= 0 || na <= 0) return null;
  return { shown: roundHalfUpDiv(o * 100, e + na), decimal2: formatHundredths(roundHalfUpDiv(o * 10000, e + na)) };
}

/** Índice = obtidos ÷ avaliados × 100, só com inteiros; `null` com denominador zero (nunca "0"). */
export function computeIndex(totals: Totals): IndexValue | null {
  const o = totals.obtainedHalfPoints;
  const e = totals.evaluatedHalfPoints;
  if (e <= 0) return null;
  const shown = roundHalfUpDiv(o * 100, e);
  const classification = classify(shown);
  const exact = reduceFrac(frac(o * 100, e));
  return {
    exact: { num: exact.n, den: exact.d },
    decimal2: formatHundredths(roundHalfUpDiv(o * 10000, e)),
    shown,
    classification,
    classificationLabel: CLASSIFICATION_LABELS_PT[classification],
  };
}
