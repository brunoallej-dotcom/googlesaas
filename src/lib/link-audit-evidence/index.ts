// Serviço de evidências (servidor). Interface PÚBLICA = o leitor autorizado, os objetos de apresentação e tipos.
// O `store` (que lê o corpo bruto e escreve) é interno: o runtime o importa por caminho direto.
export { createEvidenceReader, EvidenceAccessError } from './reader';
export type { AuditLayout, AuditSummary, AuditView, EvidenceActor, EvidenceItem, EvidenceReader, EvidenceReaderOptions, IntegrityInfo, VersionEntry, ViewState } from './reader';
export { EVIDENCE_KIND, SOURCE_LABEL, toAuditDetailDto, toListItem } from './present';
export type {
  AuditDetailDto,
  AuditListItemDto,
  ConfirmedIdentifierDto,
  DivergenceDto,
  EstablishmentDto,
  EvidenceDto,
  IdentifiersDto,
  IntegrityDto,
  SiteObservationDto,
  VersionDto,
} from './present';
export { AUDIT_ID_PATTERN } from './types';
