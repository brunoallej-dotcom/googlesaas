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
