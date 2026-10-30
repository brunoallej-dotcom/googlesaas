/*
 * Onda 6C — mapeador determinístico das evidências verificadas para o `ScoringInput` do Motor Lumos (I2). SOMENTE DE SERVIDOR.
 * Ainda sem consumidor (a prévia, a simulação e o armazenamento são os incrementos seguintes). Não importa o motor que calcula.
 */
export { assembleScoringInput } from './assemble';
export { AUDIT_ID_ALIAS_RULE, deriveAuditIdAlias, verifyAuditIdAlias } from './audit-id-alias';
export type { AuditIdAlias, AuditIdAliasReason } from './audit-id-alias';
export { AUTOMATIC_HALF_POINTS, CEILING_TODAY_HALF_POINTS, CRITERIA_SOURCES, CRITERIA_SOURCES_BY_ID, classifyOperatorRecord, decisionTargets, validateCriteriaSources, WITH_UTM_PROOF_HALF_POINTS } from './criteria-sources';
export type { BlockedReason, CriterionSource, DecisionSupport, MappedField, SourceChannel } from './criteria-sources';
export { MAPPER_VERSION, REFERENCE_DATE_RULE } from './types';
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
