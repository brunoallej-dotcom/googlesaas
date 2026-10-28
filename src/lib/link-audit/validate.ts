import { linkAuditSchema, type LinkAudit } from './audit';
import { formatZodIssues, googleNativeSourceIdentifiers, type Evidence } from './evidence';
import { parseGoogleMapsLink, type MapsIdentifiers } from './maps-link';
import { CRITERION_IDS } from './methodology';

export interface LinkAuditValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
  /** Presente somente quando `ok`. */
  readonly audit?: LinkAudit;
}

function supports(status: Evidence['status'], assessed: Evidence['status']): boolean {
  if (assessed === 'VERIFIED') return status === 'VERIFIED';
  if (assessed === 'PARTIAL') return status === 'VERIFIED' || status === 'PARTIAL';
  if (assessed === 'NOT_FOUND') return status === 'NOT_FOUND';
  return true;
}

const IDENTIFIER_KEYS = ['cid', 'placeId', 'featureId'] as const;

/** Mesmo perfil: ao menos um identificador em comum, igual, e nenhum em comum diferente. */
function consistentIdentifiers(a: MapsIdentifiers, b: MapsIdentifiers): boolean {
  const common = IDENTIFIER_KEYS.filter((key) => a[key] !== undefined && b[key] !== undefined);
  return common.length > 0 && common.every((key) => a[key] === b[key]);
}

function sameIdentifiers(a: MapsIdentifiers, b: MapsIdentifiers): boolean {
  return IDENTIFIER_KEYS.every((key) => a[key] === b[key]);
}

/**
 * Valida a estrutura e as regras entre campos de uma auditoria. Não lança, não calcula pontos e não
 * acessa rede ou banco.
 */
export function validateLinkAudit(input: unknown): LinkAuditValidation {
  try {
    return validateLinkAuditUnsafe(input);
  } catch {
    return { ok: false, issues: ['(raiz): estrutura ilegível (propriedade que lança exceção ou valor fora do contrato).'] };
  }
}

function validateLinkAuditUnsafe(input: unknown): LinkAuditValidation {
  const parsed = linkAuditSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: formatZodIssues(parsed.error) };

  const audit = parsed.data;
  const issues: string[] = [];

  const evidenceById = new Map<string, Evidence>();
  for (const evidence of audit.evidences) {
    if (evidenceById.has(evidence.id)) issues.push(`evidences: id duplicado "${evidence.id}".`);
    evidenceById.set(evidence.id, evidence);
  }

  const seen = new Set<string>();
  for (const assessment of audit.criteria) {
    if (seen.has(assessment.criterionId)) issues.push(`criteria: critério repetido "${assessment.criterionId}".`);
    seen.add(assessment.criterionId);

    const referenced: Evidence[] = [];
    if (new Set(assessment.evidenceIds).size !== assessment.evidenceIds.length) {
      issues.push(`criteria.${assessment.criterionId}: evidenceIds repetidos.`);
    }
    for (const evidenceId of assessment.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        issues.push(`criteria.${assessment.criterionId}: evidência inexistente "${evidenceId}".`);
      } else if (evidence.criterionId !== assessment.criterionId) {
        issues.push(
          `criteria.${assessment.criterionId}: a evidência "${evidenceId}" pertence ao critério ${evidence.criterionId}.`,
        );
      } else {
        referenced.push(evidence);
      }
    }
    if (assessment.status !== 'NOT_VERIFIED' && !referenced.some((evidence) => supports(evidence.status, assessment.status))) {
      issues.push(
        `criteria.${assessment.criterionId}: status ${assessment.status} sem evidência de suporte (nada é presumido).`,
      );
    }
  }
  for (const id of CRITERION_IDS) {
    if (!seen.has(id)) issues.push(`criteria: critério ausente "${id}".`);
  }

  // A identidade precisa ser coerente com o link original; evidência nativa precisa ser do mesmo perfil.
  if (audit.identity) {
    const link = parseGoogleMapsLink(audit.identity.originalLink);
    if (link.status !== 'IDENTIFIED' || !sameIdentifiers(link.identifiers, audit.identity.identifiers)) {
      issues.push('identity: os identificadores não correspondem ao originalLink (que deve ser um link https do Google Maps com identificador).');
    }
    for (const evidence of audit.evidences) {
      if (evidence.origin !== 'GOOGLE_NATIVE' || evidence.sourceUrl === undefined) continue;
      const source = googleNativeSourceIdentifiers(evidence.sourceUrl);
      if (source && !consistentIdentifiers(source, audit.identity.identifiers)) {
        issues.push(`evidences.${evidence.id}: a fonte nativa não é do perfil auditado (identificadores diferentes ou sem identificador em comum).`);
      }
    }
  }

  const confirmed = audit.state === 'IDENTITY_CONFIRMED';
  const hasIdentity = audit.identity !== null;
  if (confirmed && !audit.identity?.confirmation) {
    issues.push('state: IDENTITY_CONFIRMED exige identity.confirmation.');
  }
  if (audit.state === 'IDENTITY_PENDING_CONFIRMATION' && (!hasIdentity || audit.identity?.confirmation)) {
    issues.push('state: IDENTITY_PENDING_CONFIRMATION exige identidade ainda sem confirmação.');
  }
  const noIdentityStates: readonly string[] = [
    'LINK_INVALID',
    'LINK_REJECTED',
    'LINK_UNSUPPORTED',
    'RESOLUTION_PENDING',
    'IDENTITY_AMBIGUOUS',
  ];
  if (noIdentityStates.includes(audit.state) && hasIdentity) {
    issues.push(`state: ${audit.state} não pode ter identidade (a empresa não foi identificada).`);
  }
  if (!confirmed) {
    if (audit.evidences.length > 0) issues.push('evidences: só é permitido registrar evidências com a identidade confirmada.');
    if (audit.criteria.some((assessment) => assessment.status !== 'NOT_VERIFIED')) {
      issues.push('criteria: sem identidade confirmada todos os critérios permanecem NOT_VERIFIED.');
    }
  }

  return issues.length === 0 ? { ok: true, issues, audit } : { ok: false, issues };
}
