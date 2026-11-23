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
// W5.2b: a trava de homologação e o filtro das chaves de ensaio (`ensaio-`) da lista de confiança, compostos nas rotas de pontuação
export { isHomologationLockOn, trustKeysForServer } from './simulated';
// R2.2: a porta de reconferência da proveniência (servidor), composta nas rotas de pontuação e injetada na releitura dos resultados
export { createProvenanceRecheck } from './provenance-recheck';
export type { ProvenanceRecheck, ProvenanceRecheckConfig, ProvenanceRecheckPort } from './provenance-recheck';
