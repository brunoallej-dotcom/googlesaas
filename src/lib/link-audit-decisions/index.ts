// Serviço de decisões humanas (servidor; Fase 6, Onda 6B). Interface PÚBLICA para as rotas: o serviço, os tipos e o mapa
// de status HTTP. O armazenamento em disco (`store.ts`) é interno; nenhuma interface do navegador importa este módulo.
export { createDecisionService, HTTP_STATUS, PUBLIC_MESSAGE } from './service';
export type {
  CreatePayload,
  DecisionDto,
  DecisionService,
  DecisionServiceOptions,
  EvidenceActorLike,
  EvidenceLookup,
  Clock,
  Head,
  HistoryEntryDto,
  ListPayload,
  PendingDto,
  RevokePayload,
  ServiceErrorCode,
  ServiceFailure,
  ServiceResult,
} from './service';
export { AUDIT_ID_PATTERN } from './types';
export { evaluateKnownHeads, isUnresolved, WITNESS_NOT_REQUIRED } from './witness';
export { isLedgerBlocking, LEDGER_NOT_REQUIRED, NOT_REQUIRED_VIEW } from './ledger-port';
export type {
  DecisionRef,
  DecisionsSnapshot,
  GuardStatus,
  LedgerEntryInput,
  LedgerEnrollInput,
  LedgerFailureCode,
  LedgerHead,
  LedgerPort,
  LedgerPrepareInput,
  LedgerReason,
  LedgerRefusal,
  LedgerRunInput,
  LedgerRunPrepareInput,
  LedgerRunPrepareStep,
  LedgerRunWriteInput,
  LedgerSource,
  LedgerState,
  LedgerStep,
  LedgerView,
  LedgerViewInput,
  OpenOperation,
  ResultsEvidence,
  ResultsLedgerContext,
  ResultsLedgerPort,
  RunDraft,
  RunRefusal,
  RunRefusalCode,
  RunStep,
} from './ledger-port';
export type { KnownHead, KnownHeadsFailure, KnownHeadsProvider, KnownHeadsRead, WitnessSource, WitnessStatus, WitnessVerdict } from './witness';
