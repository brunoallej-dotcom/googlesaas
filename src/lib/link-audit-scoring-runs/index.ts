/*
 * Onda 6C — mapeador determinístico das evidências verificadas para o `ScoringInput` do Motor Lumos (I2). SOMENTE DE SERVIDOR.
 * `assemble` e os módulos puros NÃO importam o motor que calcula; só o serviço de prévia (`preview.ts`, I3) o executa.
 */
export { assembleScoringInput } from './assemble';
export { AUDIT_ID_ALIAS_RULE, deriveAuditIdAlias, verifyAuditIdAlias } from './audit-id-alias';
export type { AuditIdAlias, AuditIdAliasReason } from './audit-id-alias';
export { AUTOMATIC_HALF_POINTS, CEILING_TODAY_HALF_POINTS, CRITERIA_SOURCES, CRITERIA_SOURCES_BY_ID, classifyOperatorRecord, decisionTargets, validateCriteriaSources, WITH_UTM_PROOF_HALF_POINTS } from './criteria-sources';
export type { BlockedReason, CriterionSource, DecisionSupport, MappedField, SourceChannel } from './criteria-sources';
export { MAPPER_VERSION, REFERENCE_DATE_RULE } from './types';
export { attributeFailure, fromMapper, MAX_ATTRIBUTION_RUNS, previewBlocker, sortPreviewBlockers } from './blockers';
export type { Attribution, PreviewBlocker, PreviewBlockerCode } from './blockers';
export { deriveOutcome, MINIMUM_COVERAGE_PERCENT, toPublicView } from './outcome';
export type { InconclusiveReason, Outcome, OutcomeLevel, OutcomePreview } from './outcome';
export { createScoringPreviewService, PREVIEW_HTTP_STATUS, PREVIEW_MESSAGE } from './preview';
export type { HeldDecision, PreviewActor, PreviewCriterion, PreviewDeps, PreviewFailure, PreviewFailureCode, PreviewPayload, PreviewResult, PreviewState, PreviewSubcriterion } from './preview';
export type {
  AssembleOptions,
  AssembleResult,
  BlockerCode,
  BlockerSeverity,
  CompletenessBasis,
  CriterionSourceView,
  FactOmittedReason,
  FactSource,
  FactTrace,
  MapperBlocker,
  NoDataReason,
  ProfileTrace,
  TraceEvidence,
  TraceSource,
  Traceability,
  WebsiteTrace,
  X5ProofReason,
} from './types';
