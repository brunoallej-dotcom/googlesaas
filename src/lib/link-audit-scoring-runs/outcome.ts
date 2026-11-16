import type { CriterionResult, ScoreResult, SubcriterionResult } from '../link-audit/scoring/types';

/*
 * Desfecho e projeção PÚBLICA da prévia (spec §12.1 e §12.2). PURO. O desfecho é DERIVADO do resultado do motor (nunca do cliente):
 * o motor já devolve `ok:true` com `index:null` quando a cobertura é insuficiente, então "sem índice" NÃO é falha de integridade nem
 * bloqueio: é um resultado legítimo (`INCONCLUSIVO`, registro técnico sem nota).
 */
export type Outcome = 'PONTUADO' | 'INCONCLUSIVO';
export type OutcomeLevel = 'PROVISORIO' | 'PUBLICAVEL';
export type InconclusiveReason = 'COBERTURA_INSUFICIENTE' | 'CRITERIOS_INSUFICIENTES' | 'SEM_NAP_OU_AVALIACOES' | 'SEM_DADOS_AVALIADOS';
export const MINIMUM_COVERAGE_PERCENT = 40 as const;

export interface OutcomePreview {
  readonly outcome: Outcome;
  readonly level: OutcomeLevel | null;
  readonly reasonCode: InconclusiveReason | null;
  /** Ids dos portões de publicação que falharam. */
  readonly failedGates: readonly string[];
  readonly coveragePercent: number;
  readonly minimumCoveragePercent: typeof MINIMUM_COVERAGE_PERCENT;
}

export function deriveOutcome(result: ScoreResult): OutcomePreview {
  const { status, gates } = result.publication;
  const failedGates = gates.filter((gate) => !gate.passed).map((gate) => gate.id as string);
  const base = { failedGates, coveragePercent: result.totals.coveragePercent, minimumCoveragePercent: MINIMUM_COVERAGE_PERCENT } as const;
  if (status === 'PUBLISHED') return { outcome: 'PONTUADO', level: 'PUBLICAVEL', reasonCode: null, ...base };
  if (status === 'PROVISIONAL') return { outcome: 'PONTUADO', level: 'PROVISORIO', reasonCode: null, ...base };
  if (status === 'NO_DATA') return { outcome: 'INCONCLUSIVO', level: null, reasonCode: 'SEM_DADOS_AVALIADOS', ...base };
  const reasonCode: InconclusiveReason = failedGates.includes('COVERAGE_MIN') ? 'COBERTURA_INSUFICIENTE' : failedGates.includes('CRITERIA_MIN') ? 'CRITERIOS_INSUFICIENTES' : failedGates.includes('NAP_OR_REVIEWS') ? 'SEM_NAP_OU_AVALIACOES' : 'COBERTURA_INSUFICIENTE';
  return { outcome: 'INCONCLUSIVO', level: null, reasonCode, ...base };
}

/**
 * "Ausência nunca vira zero" (spec 6C §19.2 item 4). Em PONTUADO os pontos obtidos só existem (número) para o que o motor AVALIOU:
 * subcritério SCORED ou ABSENCE_PROVEN (o zero comprovado é avaliado) e critério EVALUATED ou PARTIAL. NOT_VERIFIED, NOT_APPLICABLE e
 * SAMPLE_INSUFFICIENT estão fora do avaliado: o campo vai `null` (o motor grava 0 só como preenchimento interno). `null` e não omissão,
 * porque em PONTUADO o campo sempre existe e `null` é a convenção dos demais campos sem valor do DTO; em INCONCLUSIVO o campo inteiro
 * é omitido (nada que pareça nota), o que é outra semântica.
 */
export const obtainedPointsOfSubcriterion = (sub: Pick<SubcriterionResult, 'state' | 'obtainedHalfPoints'>): number | null => (sub.state === 'SCORED' || sub.state === 'ABSENCE_PROVEN' ? sub.obtainedHalfPoints : null);
export const obtainedPointsOfCriterion = (item: Pick<CriterionResult, 'status' | 'obtainedHalfPoints'>): number | null => (item.status === 'EVALUATED' || item.status === 'PARTIAL' ? item.obtainedHalfPoints : null);

/** O motor escreve "(X de Y pontos)" no texto de cada subcritério pontuado: é a razão obtido ÷ avaliado, proibida em INCONCLUSIVO. */
const POINTS_IN_TEXT = /\s*\(\d+(?:[.,]\d+)? de \d+(?:[.,]\d+)? pontos?\)/g;
const NOT_APPLICABLE_TEXT = (code: string): string => `Não aplicável (${code}): fora do denominador.`;

/**
 * Projeção PÚBLICA do resultado, por LISTA DE CAMPOS PERMITIDOS (nada do motor é repassado por omissão). Regras:
 *  - o texto livre que o operador escreveu (justificativa de N/A) NUNCA sai: o motor o copia em `reason`, em `naRegistry` e nas
 *    limitações, e aqui ele é trocado por texto fixo por código;
 *  - em INCONCLUSIVO nada que pareça nota pode sair: sem índice, classificação, confiança, sensibilidade ao N/A, pontos obtidos
 *    (agregados, por critério ou por subcritério) nem a razão "(X de Y pontos)" que o motor escreve no texto do subcritério. Ficam a
 *    cobertura, o estado de cada portão, o estado e a faixa FACTUAL de cada subcritério e as limitações;
 *  - `displayData` (avaliações) nunca é repassado: o mapeador não envia avaliações, então não há o que exibir.
 */
export function toPublicView(result: ScoreResult, outcome: OutcomePreview): Record<string, unknown> {
  const showPoints = outcome.outcome === 'PONTUADO';
  const subcriteria = result.subcriteria.map((sub) => ({
    id: sub.id,
    criterionId: sub.criterionId,
    maxHalfPoints: sub.maxHalfPoints,
    state: sub.state,
    ...(showPoints ? { obtainedHalfPoints: obtainedPointsOfSubcriterion(sub) } : {}),
    evaluatedHalfPoints: sub.evaluatedHalfPoints,
    tier: sub.tier,
    reasonCode: sub.reasonCode,
    reason: sub.state === 'NOT_APPLICABLE' ? NOT_APPLICABLE_TEXT(sub.reasonCode) : showPoints ? sub.reason : sub.state === 'SCORED' || sub.state === 'ABSENCE_PROVEN' ? `Faixa factual atingida${sub.tier ? `: ${sub.tier}` : ''}.` : sub.reason.replace(POINTS_IN_TEXT, ''),
    evidenceIds: sub.evidenceIds,
    operatorRecordIds: sub.operatorRecordIds,
    grade: sub.grade,
    maxEvidenceAgeDays: sub.maxEvidenceAgeDays,
    notes: sub.notes,
  }));
  const criteria = result.criteria.map((item) => ({
    id: item.id,
    label: item.label,
    weight: item.weight,
    status: item.status,
    ...(showPoints ? { obtainedHalfPoints: obtainedPointsOfCriterion(item) } : {}),
    evaluatedHalfPoints: item.evaluatedHalfPoints,
    notApplicableHalfPoints: item.notApplicableHalfPoints,
    sampleInsufficientHalfPoints: item.sampleInsufficientHalfPoints,
    notVerifiedHalfPoints: item.notVerifiedHalfPoints,
    subcriteria: item.subcriteria,
  }));
  const { obtainedHalfPoints: _obtained, ...totalsWithoutPoints } = result.totals;
  void _obtained;
  const naByCode = new Map(result.naRegistry.map((entry) => [entry.subcriterionId as string, entry.code as string]));
  const limitations = result.limitations.map((item) => {
    if (item.code.startsWith('NOT_APPLICABLE:')) {
      const id = item.code.slice('NOT_APPLICABLE:'.length);
      return { code: item.code, text: `${id} ${NOT_APPLICABLE_TEXT(naByCode.get(id) ?? 'N/A').replace(/^Não aplicável/, 'não aplicável')}` };
    }
    return { code: item.code, text: showPoints ? item.text : item.text.replace(POINTS_IN_TEXT, '') };
  });
  return {
    kind: result.kind,
    methodologyVersion: result.methodologyVersion,
    scoreModelVersion: result.scoreModelVersion,
    rulerFingerprint: result.rulerFingerprint,
    auditId: result.auditId,
    referenceDate: result.referenceDate,
    inputSha256: result.inputSha256,
    subcriteria,
    criteria,
    totals: showPoints ? result.totals : totalsWithoutPoints,
    publication: result.publication,
    index: showPoints ? result.index : null,
    confidence: showPoints ? result.confidence : null,
    naSensitivity: showPoints ? result.naSensitivity : null,
    conflicts: result.conflicts,
    naRegistry: result.naRegistry.map((entry) => ({
      subcriterionId: entry.subcriterionId,
      code: entry.code,
      justification: NOT_APPLICABLE_TEXT(entry.code),
      causeEvidenceIds: entry.causeEvidenceIds,
      recordedBy: entry.recordedBy,
      recordedAt: entry.recordedAt,
      operatorRecordId: entry.operatorRecordId,
    })),
    limitations,
    notices: result.notices,
    resultSha256: result.resultSha256,
  };
}
