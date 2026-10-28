import type { CriterionId } from '../methodology';

/**
 * Tipos públicos do motor de pontuação (Onda 6A). Os pontos são SEMPRE inteiros em meios-pontos
 * (`...HalfPoints`): 11,5 pontos = 23. O índice é uma fração exata (nunca um float decidindo algo).
 */

export const SUBCRITERION_IDS = [
  'N1', 'N2', 'N3', 'N4', 'N5',
  'C1', 'C2', 'C3',
  'S1', 'S2', 'S3', 'S4', 'S5',
  'R1', 'R2', 'R3',
  'P1', 'P2', 'P3',
  'V1', 'V2', 'V3', 'V4', 'V5',
  'A1', 'A2', 'A3',
  'X1', 'X2', 'X3', 'X4', 'X5',
  'L1', 'L2', 'L3',
] as const;
export type SubcriterionId = (typeof SUBCRITERION_IDS)[number];

export const SUBCRITERION_STATES = ['SCORED', 'ABSENCE_PROVEN', 'NOT_VERIFIED', 'NOT_APPLICABLE', 'SAMPLE_INSUFFICIENT'] as const;
/**
 * SCORED = faixa atingida (inclui faixa zero); ABSENCE_PROVEN = zero porque a leitura suficiente mostra a ausência;
 * NOT_VERIFIED = fora do denominador (nunca zero); NOT_APPLICABLE = não existe para o negócio (registro obrigatório);
 * SAMPLE_INSUFFICIENT = o dado existe e é exibido, mas a amostra é pequena demais para pontuar.
 */
export type SubcriterionState = (typeof SUBCRITERION_STATES)[number];

export const NA_CODES = [
  'NO_REVIEWS_PROVEN',
  'NO_REPLIES_PROVEN',
  'NO_WEBSITE_PROVEN',
  'FEATURE_UNAVAILABLE',
  'BUSINESS_MODEL',
  'NO_ADDITIONAL_NEEDED',
] as const;
export type NaCode = (typeof NA_CODES)[number];

export const SAMPLE_CODES = ['REVIEWS_BELOW_MIN_SAMPLE', 'COMPETITOR_SAMPLE_BELOW_MIN'] as const;
export type SampleCode = (typeof SAMPLE_CODES)[number];

export type ReasonCode =
  | 'TIER_MATCHED'
  | 'PRESENT'
  | 'ABSENCE_PROVEN_NATIVE'
  | 'ABSENCE_PROVEN_SCOPE'
  | 'ABSENCE_PROVEN_URL'
  | 'ABSENCE_PROVEN_PROTOCOL'
  | 'ABSENCE_DERIVED'
  | 'NO_OBSERVATION'
  | 'EVIDENCE_NOT_VERIFIED'
  | 'EVIDENCE_SOURCE_NOT_ALLOWED'
  | 'HISTORICAL_ONLY'
  | 'EVIDENCE_TOO_OLD'
  | 'FIELD_NOT_EXPOSED_OR_INCOMPLETE'
  | 'CONFLICT_OPEN'
  | 'INDECISIVE_RANGE'
  | 'OPERATOR_CONFIRMATION_REQUIRED'
  | 'SITE_NOT_READ'
  | 'SITE_SCOPE_LIMITED'
  | 'DETERMINATION_NOT_VALIDATED'
  | 'DATE_NOT_AVAILABLE'
  | 'SAMPLE_TOO_SMALL'
  | 'REPLY_FIELD_NOT_EXPOSED'
  | 'WEBSITE_URL_UNPARSABLE'
  | 'NAP_NOT_COMPARABLE'
  | 'ADDRESS_UNPARSED'
  | 'HOURS_UNSTRUCTURED'
  | 'RATING_NOT_READ'
  | 'PROTOCOL_INCOMPLETE'
  | 'BASIS_MISSING'
  | NaCode
  | SampleCode;

export type EvidenceGrade = 'PRIMARY' | 'SECONDARY' | 'NONE';

export interface SubcriterionResult {
  readonly id: SubcriterionId;
  readonly criterionId: CriterionId;
  readonly maxHalfPoints: number;
  readonly state: SubcriterionState;
  readonly obtainedHalfPoints: number;
  readonly evaluatedHalfPoints: number;
  /** Rótulo da faixa atingida (ou `null` quando não pontuou). */
  readonly tier: string | null;
  readonly reasonCode: ReasonCode;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly operatorRecordIds: readonly string[];
  readonly grade: EvidenceGrade;
  /** Idade (dias) da evidência mais antiga que sustenta o subcritério; `null` sem evidência. */
  readonly maxEvidenceAgeDays: number | null;
  readonly notes: readonly string[];
}

/**
 * EVALUATED = todo o peso elegível avaliado; PARTIAL = parte avaliada; NOT_VERIFIED = nenhum ponto avaliado (exibir "N/V", nunca 0/…);
 * NOT_APPLICABLE = todo o peso é não aplicável.
 */
export type CriterionStatus = 'EVALUATED' | 'PARTIAL' | 'NOT_VERIFIED' | 'NOT_APPLICABLE';

export interface CriterionResult {
  readonly id: CriterionId;
  readonly label: string;
  readonly weight: number;
  readonly status: CriterionStatus;
  readonly obtainedHalfPoints: number;
  readonly evaluatedHalfPoints: number;
  readonly notApplicableHalfPoints: number;
  readonly sampleInsufficientHalfPoints: number;
  readonly notVerifiedHalfPoints: number;
  readonly subcriteria: readonly SubcriterionId[];
}

export interface Totals {
  readonly obtainedHalfPoints: number;
  readonly evaluatedHalfPoints: number;
  /** Cobertura global aprovada: Σ pontos avaliados ÷ 100 × 100 (inteiro, pois os máximos são inteiros). */
  readonly coveragePercent: number;
  readonly notApplicableHalfPoints: number;
  readonly sampleInsufficientHalfPoints: number;
  readonly notVerifiedHalfPoints: number;
  /** Cobertura dos elegíveis: E ÷ (100 − W_na), fração exata; `null` se não houver peso elegível. */
  readonly eligibleCoverage: { readonly n: number; readonly d: number } | null;
  /** Critérios com ao menos 3 pontos possíveis efetivamente avaliados (D3B-15). */
  readonly criteriaWithMinPoints: readonly CriterionId[];
  /** Critérios com qualquer ponto avaliado (informativo). */
  readonly criteriaWithAnyPoints: readonly CriterionId[];
}

export const PUBLICATION_STATUSES = ['NO_DATA', 'INSUFFICIENT', 'PROVISIONAL', 'PUBLISHED'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const CLASSIFICATIONS = ['CRITICAL', 'WEAK', 'DEVELOPING', 'STRONG', 'LOCAL_REFERENCE'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export interface IndexValue {
  /** Fração exata em percentual: `num ÷ den` (já reduzida). */
  readonly exact: { readonly num: number; readonly den: number };
  /** Duas casas decimais, meio para cima, calculadas só com inteiros ("83.85"). */
  readonly decimal2: string;
  /** Inteiro exibido (meio para cima). A classificação usa este valor. */
  readonly shown: number;
  readonly classification: Classification;
  readonly classificationLabel: string;
}

export interface PublicationGate {
  readonly id: 'COVERAGE_MIN' | 'CRITERIA_MIN' | 'NAP_OR_REVIEWS' | 'INTEGRITY' | 'EVALUATED_DATA';
  readonly passed: boolean;
  readonly text: string;
}

export interface Publication {
  readonly status: PublicationStatus;
  readonly gates: readonly PublicationGate[];
  readonly statusText: string;
}

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export const CONFIDENCE_FACTOR_IDS = ['COVERAGE', 'BREADTH', 'RELIABILITY', 'FRESHNESS', 'CONFLICTS', 'NA_WEIGHT'] as const;
export type ConfidenceFactorId = (typeof CONFIDENCE_FACTOR_IDS)[number];

export interface ConfidenceFactor {
  readonly id: ConfidenceFactorId;
  readonly level: ConfidenceLevel;
  /** Valor medido, como fração exata `n/d` (ex.: percentual = 100·n/d). */
  readonly value: { readonly n: number; readonly d: number };
  readonly valueText: string;
  /** Texto de modelo fixo (nunca texto livre nem IA). */
  readonly justification: string;
  /** Subcritérios ou registros que sustentam o valor (rastreabilidade). */
  readonly refs: readonly string[];
}

export interface ConfidenceResult {
  readonly level: ConfidenceLevel;
  readonly levelLabel: string;
  readonly factors: readonly ConfidenceFactor[];
  /** Fatores de nível igual ao mínimo (os que limitam a confiança). */
  readonly limitingFactors: readonly ConfidenceFactorId[];
}

export interface ConflictRecord {
  readonly field: string;
  readonly subcriteria: readonly SubcriterionId[];
  /** Só evidências e datas: os valores conflitantes NÃO são repetidos (nem em hash, que seria reversível). */
  readonly observations: ReadonlyArray<{
    readonly evidenceIds: readonly string[];
    readonly observedAt: string;
  }>;
}

export interface NaRegistryEntry {
  readonly subcriterionId: SubcriterionId;
  readonly code: NaCode;
  readonly justification: string;
  readonly causeEvidenceIds: readonly string[];
  /** `DERIVED_BY_ENGINE` quando a causa foi provada pelos próprios fatos; senão `OPERATOR_RECORD` (ver `operatorRecordId`). */
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly operatorRecordId: string | null;
}

export interface Limitation {
  readonly code: string;
  readonly text: string;
}

export interface ScoreResult {
  readonly kind: 'LUMOS_SCORE_RESULT';
  readonly methodologyVersion: string;
  readonly scoreModelVersion: string;
  readonly rulerFingerprint: string;
  readonly auditId: string;
  readonly referenceDate: string;
  readonly inputSha256: string;
  readonly subcriteria: readonly SubcriterionResult[];
  readonly criteria: readonly CriterionResult[];
  readonly totals: Totals;
  readonly publication: Publication;
  /** `null` quando o índice está indisponível (sem dados, cobertura < 40 % ou condições mínimas não atendidas). */
  readonly index: IndexValue | null;
  readonly confidence: ConfidenceResult | null;
  /** Sensibilidade do N/A: o índice se o peso não aplicável fosse tratado como zero (`null` sem índice ou sem N/A). */
  readonly naSensitivity: { readonly shown: number; readonly decimal2: string } | null;
  readonly conflicts: readonly ConflictRecord[];
  readonly naRegistry: readonly NaRegistryEntry[];
  /** Dados verificados exibidos mesmo quando não geram ponto (ex.: nota com amostra insuficiente). */
  readonly displayData: {
    readonly reviews: { readonly ratingShown: string | null; readonly reviewCount: number } | null;
  };
  readonly limitations: readonly Limitation[];
  readonly notices: readonly string[];
  readonly resultSha256: string;
}

export type ScoreOutcome =
  | { readonly ok: true; readonly result: ScoreResult }
  | { readonly ok: false; readonly issues: readonly string[] };
