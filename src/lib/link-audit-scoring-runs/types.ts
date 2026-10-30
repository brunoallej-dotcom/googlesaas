import type { CriterionId } from '../link-audit/methodology';
import type { ScoringInput } from '../link-audit/scoring/input';
import type { SubcriterionId } from '../link-audit/scoring/types';
import type { EvidenceFieldStatus } from '../link-audit-evidence/scoring-basis';
import type { AuditIdAlias } from './audit-id-alias';
import type { BlockedReason, MappedField } from './criteria-sources';

/** Versão da política de fatos do mapeador (M-12). Qualquer mudança de política exige nova versão e fixtures de ouro. */
export const MAPPER_VERSION = 'lumos-map-v1' as const;
/** Regra de derivação da `referenceDate`: o dia (como escrito) da evidência verificada mais recente da base. */
export const REFERENCE_DATE_RULE = 'LATEST_VERIFIED_EVIDENCE_DAY' as const;

export interface AssembleOptions {
  /**
   * Instante do servidor (ISO), INJETADO: o mapeador não lê relógio. Só serve às verificações de "data no futuro" (evidências e
   * decisões); NUNCA entra na entrada do motor, que não depende dele.
   */
  readonly now: string;
}

export type BlockerSeverity = 'BLOCKING' | 'WARNING';

export type BlockerCode =
  | 'MAPPER_INTERNAL_ERROR'
  | 'INVALID_OPTIONS'
  | 'BASIS_INVALID'
  | 'AUDIT_ID_INVALID'
  | 'EVIDENCE_DATED_IN_FUTURE'
  | 'OPERATOR_RECORDS_INVALID'
  | 'DECISION_DATED_IN_FUTURE'
  | 'DECISION_EVIDENCE_NOT_IN_BASE'
  | 'DECISION_NOT_SUPPORTED'
  | 'DECISION_HAS_NO_EFFECT'
  | 'ENGINE_CONTRACT_REJECTED'
  | 'PROFILE_UNAVAILABLE'
  | 'PROFILE_EVIDENCE_AGED'
  | 'PROFILE_EVIDENCE_TOO_OLD'
  | 'FIELD_CONTRADICTED_BY_REPORT'
  | 'FIELD_NOT_EMITTED';

/** `BLOCKING` impede a finalização; `WARNING` é informativo. Mensagens fixas: nunca repetem valores da fonte. */
export interface MapperBlocker {
  readonly code: BlockerCode;
  readonly severity: BlockerSeverity;
  readonly message: string;
  /** Motivo detalhado (código fixo), quando houver. */
  readonly reasonCode: string | null;
  readonly decisionIds: readonly string[];
  readonly subcriterionIds: readonly SubcriterionId[];
}

export type FactOmittedReason =
  | 'PROFILE_UNAVAILABLE'
  | 'FIELD_ABSENT'
  | 'REPORT_STATUS_CONTRADICTS'
  | 'REPORT_EVIDENCE_REQUIRED'
  | 'VALUE_EXCEEDS_CONTRACT_LIMIT'
  | 'WEBSITE_UNPARSABLE'
  | 'WEBSITE_DERIVED_NOT_MINIMAL';

export type CompletenessBasis = 'NOT_PROVEN' | 'POSITIVE_UTM_PROOF';

export type X5ProofReason =
  | 'PROVEN'
  | 'WEBSITE_NOT_EMITTED'
  | 'UTM_NOT_COMPLETE'
  | 'DERIVATION_RULE_UNKNOWN'
  | 'PROVENANCE_MISMATCH'
  | 'DERIVED_URL_INCONSISTENT'
  | 'REPORT_NOT_VERIFIED';

export interface FactTrace {
  readonly field: MappedField;
  readonly subcriteria: readonly SubcriterionId[];
  readonly emitted: boolean;
  /** `complete` enviado ao motor; só é `true` com prova positiva (M-3b). */
  readonly complete: boolean;
  readonly completenessBasis: CompletenessBasis;
  readonly evidenceRefs: readonly string[];
  /** Status da evidência `maps-*` do relatório para o campo; `NOT_LISTED` = o relatório não a trouxe (não é prova de ausência). */
  readonly reportStatus: EvidenceFieldStatus | 'NOT_LISTED' | 'NOT_APPLICABLE';
  readonly omittedReason: FactOmittedReason | null;
}

export interface TraceEvidence {
  readonly ref: string;
  readonly kind: 'CAPTURE' | 'REPORT';
  readonly observedAt: string;
  readonly contentSha256: string;
  readonly bodySha256: string | null;
  readonly legacy: boolean;
  readonly superseded: boolean;
}

export interface TraceSource {
  readonly ref: string;
  readonly observedAt: string;
  readonly contentSha256: string;
  readonly bodySha256: string;
}

export type ProfileTrace =
  | { readonly state: 'AVAILABLE'; readonly source: TraceSource; readonly ageDays: number; readonly ageStatus: 'CURRENT' | 'AGED' | 'TOO_OLD' }
  | { readonly state: 'UNAVAILABLE'; readonly reason: string }
  | { readonly state: 'NOT_EVALUATED' };

export interface WebsiteTrace {
  readonly rule: string;
  /** SHA-256 do texto do website bruto (após `trim`), para conferir contra a captura sem guardar a URL. */
  readonly rawSha256: string;
  readonly sourceEvidence: { readonly ref: string; readonly contentSha256: string; readonly bodySha256: string };
  readonly utmLevel: 'COMPLETE' | 'PARTIAL' | 'NOT_OBSERVED' | null;
  readonly x5Proof: X5ProofReason;
}

export interface Traceability {
  readonly mapperVersion: typeof MAPPER_VERSION;
  readonly basisVersion: string | null;
  readonly layout: 'VERSIONED' | 'LEGACY' | null;
  readonly auditId: AuditIdAlias | null;
  readonly referenceDate: string | null;
  readonly referenceDateSource: { readonly ref: string; readonly observedAt: string; readonly rule: typeof REFERENCE_DATE_RULE } | null;
  readonly evidences: readonly TraceEvidence[];
  readonly profile: ProfileTrace;
  readonly facts: readonly FactTrace[];
  readonly websiteDerivation: WebsiteTrace | null;
  /** M-4a estrita: nota e contagem de avaliações nunca são enviadas ao motor. */
  readonly excluded: { readonly reviews: 'EXCLUDED_M4A' };
  readonly operatorRecords: { readonly count: number; readonly ids: readonly string[] };
  readonly inputSha256: string | null;
}

/** Fonte do subcritério na matriz de critérios (spec §8). */
export type FactSource = 'AUTOMATICO' | 'DECISAO_HUMANA' | 'BLOQUEADO' | 'SEM_DADO';

export type NoDataReason = FactOmittedReason | 'EVIDENCE_TOO_OLD' | 'UTM_NOT_PROVEN' | 'AWAITING_OPERATOR_DECISION' | 'BASIS_MISSING';

export interface CriterionSourceView {
  readonly id: SubcriterionId;
  readonly criterionId: CriterionId;
  /** Peso de referência (meios-pontos). Não há pontos obtidos aqui: quem calcula é o motor. */
  readonly maxHalfPoints: number;
  readonly source: FactSource;
  readonly reasonCode: BlockedReason | NoDataReason | null;
  /** O mapeador enviou ao motor um fato que este subcritério lê (inclusive só como observação). */
  readonly factEmitted: boolean;
  readonly evidenceRefs: readonly string[];
  /** Registros do operador (decisões vigentes) que atingem este subcritério. */
  readonly decisionIds: readonly string[];
}

export interface AssembleResult {
  /** A entrada do motor, JÁ validada e normalizada por `parseScoringInput`; `null` quando o mapeador recusa entregar uma. */
  readonly input: ScoringInput | null;
  /** SHA-256 da entrada normalizada (o mesmo `inputSha256` que o motor grava no resultado). */
  readonly inputSha256: string | null;
  /** `true` só se há entrada E nenhum bloqueio `BLOCKING`. Quem finaliza NUNCA deve testar apenas `input !== null`. */
  readonly finalizable: boolean;
  readonly traceability: Traceability;
  readonly blockers: readonly MapperBlocker[];
  readonly criteriaView: readonly CriterionSourceView[];
  /** Até 10 mensagens (300 caracteres) do `parseScoringInput`, quando recusou a entrada. */
  readonly contractIssues: readonly string[];
}
