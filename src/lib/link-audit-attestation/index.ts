// Atestação offline de coleta (P1, spec link-audit-p1-attestation). Núcleo PURO: esquemas e hash do pacote; sem disco, rede nem ambiente.
export { evidenceToProveFromBasis } from '../link-audit-evidence/evidence-to-prove';
export type { EvidenceToProveSource } from '../link-audit-evidence/evidence-to-prove';
export { computePackageSha256, isPackageHashConsistent, PackageHashError } from './package-hash';
export { APPROVAL_KIND, ATTESTATION_SCHEMA_VERSION, approvalSchema, candidatePackageSchema, CHECK_IDS, MAX_PACKAGE_ENTRIES, PACKAGE_KIND, packageBodySchema } from './schemas';
export type { Approval, CandidatePackage, PackageBody } from './schemas';
