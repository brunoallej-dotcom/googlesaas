import type { CriterionId } from '../methodology';
import { formatHalfPoints } from './math';
import { subcriterionDef } from './ruler';
import type { EvidenceGrade, NaCode, ReasonCode, SampleCode, SubcriterionId, SubcriterionResult, SubcriterionState } from './types';

/** Base factual que sustenta um resultado (rastreabilidade do ponto). */
export interface Basis {
  readonly evidenceIds: readonly string[];
  readonly operatorRecordIds: readonly string[];
  readonly grade: EvidenceGrade;
  readonly maxAgeDays: number | null;
  readonly notes: readonly string[];
}

export const EMPTY_BASIS: Basis = { evidenceIds: [], operatorRecordIds: [], grade: 'NONE', maxAgeDays: null, notes: [] };

const rank: Readonly<Record<EvidenceGrade, number>> = { PRIMARY: 2, SECONDARY: 1, NONE: 0 };

/** Combina bases: evidências unidas e ordenadas; o grau é o MENOR entre as bases que têm evidência. */
export function combineBasis(...bases: ReadonlyArray<Basis | null>): Basis {
  const present = bases.filter((basis): basis is Basis => basis !== null);
  const withEvidence = present.filter((basis) => basis.evidenceIds.length > 0);
  let grade: EvidenceGrade = withEvidence.length === 0 ? 'NONE' : 'PRIMARY';
  for (const basis of withEvidence) if (rank[basis.grade] < rank[grade]) grade = basis.grade;
  const ages = present.map((basis) => basis.maxAgeDays).filter((age): age is number => age !== null);
  return {
    evidenceIds: [...new Set(present.flatMap((basis) => basis.evidenceIds))].sort(),
    operatorRecordIds: [...new Set(present.flatMap((basis) => basis.operatorRecordIds))].sort(),
    grade,
    maxAgeDays: ages.length === 0 ? null : Math.max(...ages),
    notes: [...new Set(present.flatMap((basis) => basis.notes))],
  };
}

export function withNotes(basis: Basis, ...notes: string[]): Basis {
  return { ...basis, notes: [...new Set([...basis.notes, ...notes])] };
}

function build(
  id: SubcriterionId,
  state: SubcriterionState,
  obtainedHalfPoints: number,
  tier: string | null,
  reasonCode: ReasonCode,
  reason: string,
  basis: Basis,
): SubcriterionResult {
  const def = subcriterionDef(id);
  const evaluated = state === 'SCORED' || state === 'ABSENCE_PROVEN';
  const evaluatedHalfPoints = evaluated ? def.maxHalfPoints : 0;
  const obtained = evaluated ? obtainedHalfPoints : 0;
  if (!Number.isInteger(obtained) || obtained < 0 || obtained > evaluatedHalfPoints) {
    throw new Error(`pontos inválidos em ${id}: ${obtained} de ${evaluatedHalfPoints}`);
  }
  if (state === 'ABSENCE_PROVEN' && obtained !== 0) throw new Error(`ausência comprovada de ${id} precisa valer 0`);
  if (evaluated && basis.evidenceIds.length === 0) {
    throw new Error(`ponto sem rastreabilidade em ${id}`);
  }
  return {
    id,
    criterionId: def.criterionId as CriterionId,
    maxHalfPoints: def.maxHalfPoints,
    state,
    obtainedHalfPoints: obtained,
    evaluatedHalfPoints,
    tier,
    reasonCode,
    reason,
    evidenceIds: basis.evidenceIds,
    operatorRecordIds: basis.operatorRecordIds,
    grade: basis.grade,
    maxEvidenceAgeDays: basis.maxAgeDays,
    notes: basis.notes,
  };
}

export function scored(id: SubcriterionId, halfPoints: number, tier: string, reason: string, basis: Basis, code: ReasonCode = 'TIER_MATCHED'): SubcriterionResult {
  return build(id, 'SCORED', halfPoints, tier, code, `${reason} (${formatHalfPoints(halfPoints)} de ${formatHalfPoints(subcriterionDef(id).maxHalfPoints)} pontos).`, basis);
}

export function absence(id: SubcriterionId, code: ReasonCode, reason: string, basis: Basis): SubcriterionResult {
  return build(id, 'ABSENCE_PROVEN', 0, null, code, `${reason} Ausência comprovada: 0 ponto avaliado.`, basis);
}

export function notVerified(id: SubcriterionId, code: ReasonCode, reason: string, basis: Basis = EMPTY_BASIS): SubcriterionResult {
  return build(id, 'NOT_VERIFIED', 0, null, code, `${reason} Não verificado: fora do denominador (não é zero).`, basis);
}

export function notApplicable(id: SubcriterionId, code: NaCode, reason: string, basis: Basis): SubcriterionResult {
  return build(id, 'NOT_APPLICABLE', 0, null, code, `${reason} Não aplicável: fora do denominador.`, basis);
}

export function sampleInsufficient(id: SubcriterionId, code: SampleCode, reason: string, basis: Basis): SubcriterionResult {
  return build(id, 'SAMPLE_INSUFFICIENT', 0, null, code, `${reason} Amostra insuficiente: o dado é exibido, mas não gera ponto.`, basis);
}
